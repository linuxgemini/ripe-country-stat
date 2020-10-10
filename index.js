#!/usr/bin/env node

/* eslint-disable no-case-declarations */

/**
 * @license MIT
 * Copyright 2020 İlteriş Yağıztegin Eroğlu (linuxgemini)
 * SPDX-License-Identifier: MIT
 */

"use strict";

const chalk = require("chalk");
const cliProgress = require("cli-progress");
const csvStringify = require("csv-stringify/lib/sync");
const dns = require("dns").promises;
const fetch = require("node-fetch");
const fs = require("fs");
const inquirer = require("inquirer");
const program = require("commander");

/*
 * API Endpoint Constants
 */
const RIPESTAT_AS_OVERVIEW_URL  = "https://stat.ripe.net/data/as-overview/data.json";
const RIPESTAT_COUNTRY_ASNS_URL = "https://stat.ripe.net/data/country-asns/data.json";
const RIPESTAT_RIS_PREFIXES_URL = "https://stat.ripe.net/data/ris-prefixes/data.json";

/**
 * Constants that doesn't have to change
 */
const SCRIPT_NAME = "ripe-country-stat_js";

/**
 * Critical constants
 * DON'T CHANGE
 */
const COUNTRY_ASNS_REGEX = /{?(AsnSingle\()(\d+)(\),? ?)}?/g; // ASN is on $2
const COUNTRY_CODES = require("./cc.json");
const dnsresolver = new dns.Resolver();
dnsresolver.setServers([
    "1.1.1.1",
    "1.0.0.1",
    "2606:4700:4700::1111",
    "2606:4700:4700::1001",
    "9.9.9.9"
]);
let printedMessages = [];

class ripeStatError extends Error {
    constructor(errmessage = "no message provided.", ...params) {
        super(...params);

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, ripeStatError);
        }

        this.message = errmessage;
        this.date = new Date();
        this.type = "ripeStatError";
    }
}

const exit = () => {
    return setTimeout(() => {
        process.exit(0);
    }, 1000);
};

/**
 * @param {Error} err
 */
const exitWithError = (err) => {
    console.error("\n\nAn error occured!\n");
    if (err.stack) console.error(`\nStacktrace:\n${err.stack}\n`);
    return setTimeout(() => {
        process.exit(1);
    }, 1000);
};

/**
 * @param {Error} err
 */
const exitWithRIPEerror = (err) => {
    console.error(`\n\nRIPEstat ${chalk.red("error")}: ${chalk.yellow(err.message)}`);
    return setTimeout(() => {
        process.exit(0);
    }, 1000);
};

/**
 * @param {string} apiURL
 * @param {string} resource
 * @param {{}|any} extraParams
 */
const generateURLWithQueryParams = (apiURL, resource, extraParams = {}) => {
    let qs = new URLSearchParams({
        resource,
        "sourceapp": SCRIPT_NAME,
        "soft_limit": "ignore",
        ...extraParams
    });
    return `${apiURL}?${qs}`;
};

const createCSV = (asnObjectArray) => {
    return csvStringify(asnObjectArray, {
        header: true,
        columns: {
            asn: "AS Number",
            asnOrg: "Organization Name",
            prefixCount4: "Announced IPv4 Prefix Count",
            prefixCount6: "Announced IPv6 Prefix Count"
        }
    });
};

/**
 * @param {string} str
 * @param {RegExp} regexp
 * @param {number} index
 * @returns {string}
 */
const getRegexGroupFromIndex = (str, regexp, index) => {
    return Array.from(str.matchAll(regexp), match => match[index]);
};

/**
 * @param {Object} object
 * @param {any} value
 * @returns {any}
 */
const getKeyByValue = (object, value) => {
    return Object.keys(object).find(key => object[key] === value);
};

/**
 * @param {string[][]} bigArr
 * @param {boolean} ignoreMsg
 */
const processRIPEmessages = async (bigArr, ignoreMsg = false) => {
    const caller = (new Error()).stack.split("\n")[2].trim().split(" ")[1];
    if (bigArr && bigArr.length !== 0) {
        for (const messageArray of bigArr) {
            let msg;
            switch (messageArray[0].toLowerCase()) {
                case "info":
                    msg = `RIPEstat ${chalk.blue("info")} (${caller}): ${messageArray[1]}`;
                    if (!printedMessages.includes(msg) && !ignoreMsg) {
                        console.log(msg);
                        printedMessages.push(msg);
                    }
                    break;
                case "error":
                    throw new ripeStatError(messageArray[1]);
                default:
                    msg = `RIPEstat ${chalk.yellow(messageArray[0])} (${caller}): ${messageArray[1]}`;
                    if (!printedMessages.includes(msg) && !ignoreMsg) {
                        console.log(msg);
                        printedMessages.push(msg);
                    }
                    break;
            }
        }
    }
    return;
};

/**
 * @param {string} str
 * @returns {string}
 */
const strStrip = (str) => {
    const regexStart = /^\s+/;
    const regexEnd = /\s+$/;

    return str.replace(regexStart, "").replace(regexEnd, "");
};

/**
 * @deprecated
 * @param {string} asn
 * @returns {string}
 */
const getASNname = async (asn) => { // eslint-disable-line no-unused-vars
    const raw = await fetch(generateURLWithQueryParams(RIPESTAT_AS_OVERVIEW_URL, asn));
    const data = await raw.json();

    await processRIPEmessages(data.messages);

    return data.data.holder;
};

/**
 * @param {string} asn
 */
const getASNnameOverDNS = async (asn) => {
    const callDomain = `AS${asn}.asn.cymru.com`;
    const reply = await dnsresolver.resolveTxt(callDomain);

    let infoArray = strStrip(reply[0][0]).replace(/( \| )/g, "--||--").split("--||--");

    return infoArray[4].slice(0,-4);
};

/**
 * @param {string} asn
 */
const getOriginatedPrefixCount = async (asn) => {
    const raw = await fetch(generateURLWithQueryParams(RIPESTAT_RIS_PREFIXES_URL, asn));
    const data = await raw.json();

    await processRIPEmessages(data.messages, true);

    return {
        /** @type {number} */
        prefixCount4: data.data.counts.v4.originating,
        /** @type {number} */
        prefixCount6: data.data.counts.v6.originating
    };
};

/**
 * @param {string} cc
 */
const getCountryASNs = async (cc) => {
    cc = cc.toUpperCase();
    console.log(`Getting ASN list of ${COUNTRY_CODES[cc]}...`);
    const raw = await fetch(generateURLWithQueryParams(RIPESTAT_COUNTRY_ASNS_URL, cc, { lod: 1 }));
    const data = await raw.json();
    
    await processRIPEmessages(data.messages);

    const activeASNs = (data.data.countries[0].routed && (data.data.countries[0].routed !== "" || data.data.countries[0].routed !== "set()") ? getRegexGroupFromIndex(data.data.countries[0].routed, COUNTRY_ASNS_REGEX, 2).sort((a, b) => (parseInt(a) - parseInt(b))) : []);
    const inactiveASNs = (data.data.countries[0].non_routed && (data.data.countries[0].non_routed !== "" || data.data.countries[0].non_routed !== "set()") ? getRegexGroupFromIndex(data.data.countries[0].non_routed, COUNTRY_ASNS_REGEX, 2).sort((a, b) => (parseInt(a) - parseInt(b))) : []);
    
    const allASNs = activeASNs.concat(inactiveASNs).sort((a, b) => (parseInt(a) - parseInt(b)));

    console.log(`${COUNTRY_CODES[cc]}:
    ${activeASNs.length} Active ASNs
    ${inactiveASNs.length} Inactive ASNs
    ${allASNs.length} Total ASNs`);

    return {
        /** @type {string[]} */
        activeASNs,
        /** @type {string[]} */
        inactiveASNs,
        /** @type {string[]} */
        allASNs
    };
};

const main = () => {
    program
        .version("0.1.0", "-v, --version")
        .description("Get the IP prefix count stats for any country.");

    program
        .action(async () => {
            const progress = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
            let isProgressStarted = false;
            try {
                let typePrompt = await inquirer.prompt([
                    {
                        "type": "list",
                        "name": "method",
                        "message": "How do you want to select the country?",
                        "choices": [
                            "Enter ISO-3166-1 alpha-2 code",
                            "Select from list"
                        ],
                        "default": 0
                    }
                ]);

                let countryCode;

                switch (typePrompt.method) {
                    case "Select from list":
                        let countryPrompt = await inquirer.prompt([
                            {
                                "type": "list",
                                "name": "country",
                                "message": "Please select the country:",
                                "choices": Object.values(COUNTRY_CODES)
                            }
                        ]);
                        countryCode = getKeyByValue(COUNTRY_CODES, countryPrompt.country);
                        break;
                    case "Enter ISO-3166-1 alpha-2 code":
                        let alphaCodePrompt = await inquirer.prompt([
                            {
                                "type": "input",
                                "name": "alphaCode",
                                "message": "Please enter the ISO-3166-1 alpha-2 code:",
                                "validate": (cc) => {
                                    if (!COUNTRY_CODES[cc.toUpperCase()]) return false;
                                    return true;
                                }
                            }
                        ]);
                        countryCode = alphaCodePrompt.alphaCode;
                        break;
                    default:
                        break;
                }

                let countryASNs = await getCountryASNs(countryCode);
                let finalArr = [];
                
                if (countryASNs.allASNs.length === 0) {
                    console.log(chalk.yellow("No ASNs found, quitting..."));
                    return exit();
                }

                console.log(chalk.yellow("This process may take quite a while (and may even error) depending on country, get a coffee and do something else while this is running."));
                progress.start(countryASNs.allASNs.length, 0);
                isProgressStarted = true;

                for (const asn of countryASNs.activeASNs) {
                    const asnOrg = await getASNnameOverDNS(asn);
                    const prefixes = await getOriginatedPrefixCount(asn);
                    finalArr.push({
                        asn,
                        asnOrg,
                        ...prefixes
                    });
                    progress.increment(1);
                }

                for (const asn of countryASNs.inactiveASNs) {
                    const asnOrg = await getASNnameOverDNS(asn);
                    finalArr.push({
                        asn,
                        asnOrg,
                        prefixCount4: 0,
                        prefixCount6: 0
                    });
                    progress.increment(1);
                }

                progress.stop();

                finalArr = finalArr.sort((a, b) => (parseInt(a.asn) - parseInt(b.asn)));

                fs.writeFileSync(`./${countryCode.toUpperCase()}.csv`, createCSV(finalArr));
                console.log(`
${chalk.green(`Processed ${finalArr.length} ASNs.`)}
Saved to "${countryCode.toUpperCase()}.csv".`);
                exit();
            } catch (e) {
                if (isProgressStarted) progress.stop();
                if (e.type && e.type === "ripeStatError") {
                    exitWithRIPEerror(e);
                } else {
                    exitWithError(e);
                }
            }
        });

    program.parse(process.argv);
};

main();
