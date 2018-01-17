const { log, error } = console;

const args = process.argv.slice(2);
if (args.length !== 3) {
    error('call: program [index.php] [wcf_cookieHash] [User-Agent]');
    error("example: node crawler.js 0929e19bf86e9ae1664310447558481638e3ff92 'Mozilla/5.0 (X11; Linux x86_64) Safari/537.36' '......forum/index.php'");
    process.exit(1);
}

const jsdom = require('jsdom');

const { window } = new jsdom.JSDOM();

const $ = require('jquery')(window);
const fetch = require('node-fetch');
const html2plaintext = require('html2plaintext');
const fs = require('fs');

const headers = {
    Cookie: `wcf_cookieHash=${args[0]}`,
    'User-Agent': args[1],
};
const baseUrl = args[2];

function zeropad(number) {
    let str = `${number}`;
    while (str.length < 5) {
        str = 0 + str;
    }
    return str;
}

async function getRes(url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
        log(url, res.statusText, res.status);
        process.exit(res.status);
    }
    return res;
}

async function getHtml(url) {
    const res = await getRes(url);
    return res.text();
}

async function saveUrl(url, filename) {
    const res = await getRes(url);
    const stream = fs.createWriteStream(filename);
    res.body.pipe(stream);
}

const visitedThreads = new Set();

async function downloadThread(url, path) {
    if (visitedThreads.has(url)) {
        error(`[thread] skipping: ${path}`);
        return;
    }
    visitedThreads.add(url);
    log(path); // todo
}

const visitedBoards = new Set();

async function iterateBoards(url, path) {
    if (visitedBoards.has(url)) {
        error(`[board] skipping: ${path}`);
        return;
    }
    visitedBoards.add(url);

    const html = $(await getHtml(url));
    html
        .find(`#boardlist > li.border > ul > li > div.boardlistInner > div.boardlistTitle > div.containerContent > .boardTitle > a,
               #boardlist > li.border > div.boardlistInner:not(.containerHead) > div.boardlistTitle > div.containerContent > .boardTitle > a`)
        .each((boardIndex, aBoard) => {
            const board = `${zeropad(boardIndex)} ${aBoard.text}`;
            const subpath = `${path}/${board}`;
            iterateBoards(aBoard.href, subpath); // recursive
        });
    html
        .find('div#normalThreadsStatus > table.tableList > tbody > tr > td.columnTopic > div.topic > p > a')
        .each((topicIndex, aTopic) => {
            const topic = `${zeropad(topicIndex)} ${aTopic.text}`;
            const subpath = `${path}/${topic}`;
            downloadThread(aTopic.href, subpath);
        });
}

(async function main() {
    log('starting');
    iterateBoards(baseUrl, '.');
}());
