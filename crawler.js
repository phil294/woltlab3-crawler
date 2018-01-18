const { log, error } = console;

const args = process.argv.slice(2);
if (args.length !== 3) {
    error('call: program [root_dir] [wcf_cookieHash] [User-Agent]');
    error("example: node crawler.js 0929e19bf86e9ae1664310447558481638e3ff92 'Mozilla/5.0 (X11; Linux x86_64) Safari/537.36' 'https://cor-forum.de'");
    process.exit(1);
}

const jsdom = require('jsdom');

const { window } = new jsdom.JSDOM();

const $ = require('jquery')(window);
const fetch = require('node-fetch');
const htmlToText = require('html-to-text');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const headers = {
    Cookie: `wcf_cookieHash=${args[0]}`,
    'User-Agent': args[1],
};
const rootUrl = args[2].replace(/\/$/, '');

const db = new sqlite3.Database(`forum_backup${new Date().getTime()}.sqlite`);
db.serialize(() => {
    db.run('CREATE TABLE threads (id INTEGER PRIMARY KEY ASC, path TEXT)');
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY ASC, name TEXT)');
    db.run('CREATE TABLE posts (id INTEGER PRIMARY KEY ASC, thread INTEGER, user INTEGER, username TEXT, timestamp INTEGER, message TEXT, FOREIGN KEY(thread) REFERENCES threads(id), FOREIGN KEY(user) REFERENCES users(id))');
});

// ////////////////////////////////////////

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
    const text = await res.text();
    if (!text.match(/<li id="userMenuLogout">/)) {
        error('session invalid');
        process.exit(403);
    }
    return text;
}

async function saveUrl(url, filename) {
    const res = await getRes(url);
    const stream = fs.createWriteStream(filename);
    res.body.pipe(stream);
}

function absoluteUrl(url) {
    if (!/^https?:\/\//i.test(url)) {
        return `${rootUrl}/${url}`;
    }
    return url;
}

function parseMessage(messageHtml) {
    let message = messageHtml.replace(/<\/?blockquote[^>]*>/g, '<br>-----------------<br>');
    message = htmlToText.fromString(message, {
        format: {
            anchor: (elem, fn, options) => {
                const n = fn(elem.children, options);
                return `<a href="${elem.attribs.href}" alt="${elem.attribs.alt}">${n}</a>`; // preserve links as html
            },
            image: (elem, fn, options) => {
                if (elem.attribs.src.match(/\/images\/smil(ie|ey)s\//)) {
                    return elem.attribs.alt;
                }
                // download img todo
                return `<img src="${elem.attribs.src}" alt="${elem.attribs.alt}" />`; // preserve
            },
            heading: (elem, fn, options) => {
                const h = fn(elem.children, options);
                return `**${h}**\n`;
            },
        },
    });
    return message;
}

/** woltlabs mysterious "time" modificator - // Monday, March 20th 2017, 3:37pm */
function parseTime(timestring) {
    let month;
    let day;
    let year;
    let hour;
    let min;
    // convert to Date.parse('March 20 2017 13:37') because javascript
    let match = /^[A-z]+, ([A-z]+) ([0-9]+)[A-z]+ ([0-9]+), ([0-9]+):([0-9]+)[A-z]+$/.exec(timestring);
    if (match !== null) {
        [, month, day, year, hour, min] = match;
    } else {
        match = /^([A-z]+), ([0-9]+):([0-9]+)[A-z]+$/.exec(timestring);
        [, day, hour, min] = match;
        if (match === null) {
            error(`cannot parse date ${timestring}`);
        } else {
            const date = new Date();
            if (day === 'Yesterday') {
                date.setDate(date.getDate() - 1);
            }
            day = date.getDate();
            month = date.getMonth() + 1;
            year = date.getFullYear();
        }
    }
    hour *= 1;
    if (timestring.match(/pm$/) && hour < 12) {
        hour += 12;
    }
    const timestamp = Date.parse(`${month} ${day} ${year} ${hour}:${min}`);
    if (Number.isNaN(timestamp)) {
        error(`could not parse date: ${timestring}`);
    }
    return timestamp;
}

const visitedThreads = new Set();

async function downloadThread(baseUrl, path, pageMax) {
    if (visitedThreads.has(baseUrl)) {
        error(`[thread] skipping: ${path}`);
        return;
    }
    visitedThreads.add(baseUrl);

    const dbThreadId = await new Promise(r => db.run('INSERT INTO threads (path) VALUES (?)', path, function cb() {
        r(this.lastID);
    }));

    // get pages of this thread
    const pageUrls = [baseUrl];
    for (let i = 2; i <= pageMax; i++) {
        pageUrls.push(`${baseUrl}index${i}.html`);
    }

    // visit pages & save
    await pageUrls.forEach(async (pageUrl) => { // todo to await or not to async
        const jPageHtml = $(await getHtml(pageUrl));
        jPageHtml.find('#main > .message > .messageInner')
            .each((_, divMessage) => {
                const jDivMessage = $(divMessage);
                const timestring = jDivMessage.find('> div.messageContent > div.messageContentInner > div.messageHeader > div.containerContent > p.smallFont.light').text();
                // const timestamp = parseTime(timestring) / 1000; // FIXME
                const timestamp = 1000000000;
                // const postNumber = jDivMessage.find('> div.messageContent > div.messageContentInner > div.messageHeader > p.messageCount > a').text();
                const username = jDivMessage.find('> div.messageSidebar > div.messageAuthor > p.userName > a > span').text();
                const messageHtml = jDivMessage.find('> div.messageContent > div.messageContentInner > div.messageBody > div').html();
                let message = parseMessage(messageHtml);

                // attachments
                jDivMessage.find('> div.messageContent > div.messageContentInner > fieldset.attachmentFile > ul > li > div > a')
                    .each((__, aAttachment) => {
                        const attachmentHref = aAttachment.href;
                        const attachmentId = attachmentHref.replace(/^.+&attachmentID=([0-9]+)([^0-9].*$|$)/, '$1');
                        saveUrl(`attachments/${attachmentHref}`, attachmentId);
                        message += `\nAttachment:\n<img src="attachments/${attachmentHref}`;
                    });

                log(pageUrl, username);
                db.run('INSERT INTO posts (thread, timestamp, username, message) VALUES (?,?,?,?)', dbThreadId, timestamp, username, message, (errormessage) => {
                    if (errormessage !== null) {
                        error(errormessage);
                    }
                });
                return false;
            });
    });
}

const visitedBoards = new Set();

async function iterateBoards(url, path) {
    if (visitedBoards.has(url)) {
        error(`[board] skipping: ${path}`);
        return;
    }
    visitedBoards.add(url);

    // find sub-boards
    const jHtml = $(await getHtml(url));
    jHtml
        .find(`#boardlist > li.border > ul > li > div.boardlistInner > div.boardlistTitle > div.containerContent > .boardTitle > a,
               #boardlist > li.border > div.boardlistInner:not(.containerHead) > div.boardlistTitle > div.containerContent > .boardTitle > a`)
        .each((boardIndex, aBoard) => {
            const board = `${zeropad(boardIndex)} ${aBoard.text}`;
            const subpath = `${path}/${board}`;
            iterateBoards(absoluteUrl(aBoard.href), subpath); // recursive
        });

    // this board: get page urls
    const pageMax = jHtml.find('#main > div.contentHeader > div.pageNavigation > ul > li:nth-last-child(2) > a').text();
    const pageUrls = [url];
    for (let i = 2; i <= pageMax; i++) {
        pageUrls.push(`${url}index${i}.html`);
    }
    // visit all pages of board
    pageUrls.forEach(async (pageUrl) => {
        const jPageHtml = $(await getHtml(pageUrl));
        jPageHtml.find('div:not(#topThreadsStatus):not(.tabMenuContent) > table.tableList > tbody > tr > td.columnTopic')
            .each((topicIndex, tdTopic) => {
                const jTdTopic = $(tdTopic);

                const topicPageMax = jTdTopic.find('> div.statusDisplay > div.pageNavigation > ul > li:last-child() > a').text(); // empty or 2+

                const aTopic = jTdTopic.find('> div.topic > p > a')[0];
                const topic = `${zeropad(topicIndex)} ${aTopic.text}`;
                const subpath = `${path}/${topic}`;

                downloadThread(absoluteUrl(aTopic.href), subpath, topicPageMax);
            });
    });
}

process.on('exit', () => {
    db.close();
    log('exit');
});
(async function main() {
    log('starting');
    await iterateBoards(rootUrl, '.');
}());
