const { log, error } = console;

const args = process.argv.slice(2);
if (args.length !== 3) {
    error('call: program [wcf_cookieHash] [User-Agent] [root_dir]');
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
if (rootUrl.match(/\.php$/)) {
    error('specify root dir without index.php, e.g. "domain.com/forum" instead of "domain.com/forum/index.php"');
    process.exit(4);
}

const db = new sqlite3.Database(`forum_backup${new Date().getTime()}.sqlite`);
db.serialize(() => {
    db.run('CREATE TABLE threads (id INTEGER PRIMARY KEY ASC, path TEXT)');
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY ASC, name TEXT, profilePicPath TEXT, info TEXT)');
    db.run('CREATE TABLE guestbook_entries (user INTEGER, username TEXT, author INTEGER, authorname TEXT, timestamp INTEGER, message TEXT)');
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
        // process.exit(res.status);
        return false;
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
    if (res) {
        const stream = fs.createWriteStream(filename);
        res.body.pipe(stream);
    }
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
            image: (elem) => {
                if (elem.attribs.src.match(/\/images\/smil(ie|ey)s\//)) {
                    return elem.attribs.alt; // woltlab wcf smileys: pure alt
                }
                // download this external img maybe todo
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
        if (match === null) {
            error(`cannot parse date ${timestring}`);
        } else {
            [, day, hour, min] = match;
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

async function downloadThread(baseUrl, path, pageMax, progressString) {
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

    // visit pages iteratively & save
    for (const [pageIndex, pageUrl] of pageUrls.entries()) {
        const jPageHtml = $(await getHtml(pageUrl));
        // save all messages to db
        const jDivMessages = jPageHtml.find('#main > .message > .messageInner');
        log(`${progressString}, page ${pageIndex + 1}/${pageUrls.length}, ${jDivMessages.length} posts`);
        jDivMessages.each((_, divMessage) => {
            const jDivMessage = $(divMessage);
            const timestring = jDivMessage.find('> div.messageContent > div.messageContentInner > div.messageHeader > div.containerContent > p.smallFont.light').text();
            const timestamp = parseTime(timestring) / 1000;
            const username = jDivMessage.find('> div.messageSidebar > div.messageAuthor > p.userName > a > span').text();
            const messageHtml = jDivMessage.find('> div.messageContent > div.messageContentInner > div.messageBody > div').html();
            let message = parseMessage(messageHtml);

            // attachments
            jDivMessage.find('> div.messageContent > div.messageContentInner > fieldset.attachmentFile > ul > li > div > a')
                .each((__, aAttachment) => {
                    const attachmentHref = aAttachment.href;
                    const attachmentId = attachmentHref.replace(/^.+&attachmentID=([0-9]+)([^0-9].*$|$)/, '$1');
                    saveUrl(attachmentHref, `attachments/${attachmentId}`); // async in background
                    message += `\nAttachment:\n<img src="attachments/${attachmentId}" />`;
                });

            db.run('INSERT INTO posts (thread, timestamp, username, message) VALUES (?,?,?,?)', dbThreadId, timestamp, username, message, (errormessage) => {
                if (errormessage !== null) {
                    error(errormessage);
                }
            });
        });
    }
}

const visitedBoards = new Set();

async function iterateBoards(url, path, currentProgressString) {
    if (visitedBoards.has(url)) {
        error(`[board] skipping: ${path}`);
        return;
    }
    visitedBoards.add(url);

    const jHtml = $(await getHtml(url));
    // find sub-boards
    const aBoards = jHtml
        .find(`#boardlist > li.border > ul > li > div.boardlistInner > div.boardlistTitle > div.containerContent > .boardTitle > a,
               #boardlist > li.border > div.boardlistInner:not(.containerHead) > div.boardlistTitle > div.containerContent > .boardTitle > a`);
    // iterative for await
    for (let boardIndex = 0; boardIndex < aBoards.length; boardIndex++) {
        const jABoard = $(aBoards[boardIndex]);
        const board = `${zeropad(boardIndex)} ${jABoard.text()}`;
        const subpath = `${path}/${board}`;
        const nextProgressString = `${currentProgressString}, board ${boardIndex + 1}/${aBoards.length}`;
        await iterateBoards(absoluteUrl(jABoard.prop('href')), subpath, nextProgressString); // "synchronous" recursive
    }

    // this board: get page urls
    const pageMax = jHtml.find('#main > div.contentHeader > div.pageNavigation > ul > li:nth-last-child(2) > a').text(); // FIXME if > 1k, comma error (guestbook does it right)
    const pageUrls = [url];
    for (let i = 2; i <= pageMax; i++) {
        pageUrls.push(`${url}index${i}.html`);
    }

    // visit all pages of board
    for (const [pageIndex, pageUrl] of pageUrls.entries()) {
        const jPageHtml = $(await getHtml(pageUrl));
        const tdTopics = jPageHtml.find('div:not(#topThreadsStatus):not(.tabMenuContent) > table.tableList > tbody > tr > td.columnTopic');

        for (let topicIndex = 0; topicIndex < tdTopics.length; topicIndex++) {
            const jTdTopic = $(tdTopics[topicIndex]);

            const topicPageMax = jTdTopic.find('> div.statusDisplay > div.pageNavigation > ul > li:last-child() > a').text(); // empty or 2+

            const aTopic = jTdTopic.find('> div.topic > p > a')[0];
            const topic = `${zeropad(topicIndex)} ${aTopic.text}`;
            const subpath = `${path}/${topic}`;

            const progressString = `${currentProgressString}, page ${pageIndex + 1}/${pageUrls.length}, thread ${topicIndex + 1}/${tdTopics.length}`;
            await downloadThread(absoluteUrl(aTopic.href), subpath, topicPageMax, progressString);
        }
    }
}

async function downloadGuestBook(userId, username, progressString) {
    const guestbookUrl = `${rootUrl}?page=UserGuestbook&userID=${userId}`;
    const htmlGuestbook = await getHtml(guestbookUrl);
    let guestbookMaxPage;
    const textGuestbookMaxPage = $(htmlGuestbook).find('#main > div.guestBook > div > div.contentHeader > div.pageNavigation > ul > li:nth-last-child(2) > a').text();
    if (textGuestbookMaxPage !== undefined) {
        guestbookMaxPage = textGuestbookMaxPage.replace(/[^0-9]/g, '');
    } else {
        guestbookMaxPage = 1;
    }
    for (let guestbookPage = 1; guestbookPage <= guestbookMaxPage; guestbookPage++) {
        const htmlGuestbookPage = await getHtml(`${guestbookUrl}&pageNo=${guestbookPage}`);
        const jDivMessages = $(htmlGuestbookPage).find('#main > div.guestBook > div > div.guestBookInner > .message > .messageInner');
        log(`${progressString}, guestbook page ${guestbookPage}/${guestbookMaxPage}, ${jDivMessages.length} entries`);
        for (let guestbookPageMessageIndex = 0; guestbookPageMessageIndex < jDivMessages.length; guestbookPageMessageIndex++) {
            const jDivMessage = $(jDivMessages[guestbookPageMessageIndex]);
            const jPMessageHeaderStrings = jDivMessage.find('> div.messageHeader > div.containerContent > p.smallFont.light');
            const timestring = $(jPMessageHeaderStrings[0]).text();
            const timestamp = parseTime(timestring) / 1000;
            const authorname = $(jPMessageHeaderStrings[1]).find('> a').text();
            const messageHtml = jDivMessage.find('> div.messageBody').html();
            const message = parseMessage(messageHtml);
            db.run('INSERT INTO guestbook_entries (username, authorname, timestamp, message) VALUES (?,?,?,?)', username, authorname, timestamp, message);
        }
    }
}

async function downloadUserprofile(url, username, progressString) {
    const html = await getHtml(url);
    const userId = url.replace(/^.+\/user\/([0-9]+).+$/, '$1');
    const jDivMain = $(html).find('#main');
    const profilePicSrc = jDivMain
        .find('> div#userCard > div.userCardInner > ul.userCardList > li#userCardAvatar > div.userAvatar > a > img').prop('src');
    let profilePicPath = '';
    if (!profilePicSrc.match('default')) {
        profilePicPath = profilePicSrc.replace(/^.+\/avatar-([0-9]+\..+)$/, '$1');
        saveUrl(absoluteUrl(profilePicSrc), `userprofilepics/${profilePicPath}`);
    }
    // all info concatd as text
    let infoHtml = '';
    jDivMain.find('> div.border > div > div.columnContainer > div > div.columnInner > div.contentBox')
        .each((_, divAboutContentBox) => { // about + signature + personal information
            infoHtml += divAboutContentBox.innerHTML;
        });
    const sidebar = jDivMain.find('> div.border > div > div.columnContainer > div.second.sidebar.profileSidebar > div.columnInner').html();
    if (sidebar !== undefined) {
        infoHtml += sidebar;
    }
    const info = parseMessage(infoHtml);
    db.run('INSERT INTO users (name, profilePicPath, info) VALUES (?,?,?)', username, profilePicPath, info);

    if (jDivMain.find('.contentBox > .subHeadline > a:contains("Guestbook")').length > 0) { // guestbook public / userprofile not private
        await downloadGuestBook(userId, username, progressString);
    }
}

async function iterateMemberslist() {
    const baseUrl = `${rootUrl}?page=MembersList&searchID=0&sortField=posts&sortOrder=DESC&letter=`;
    const baseHtml = await getHtml(baseUrl);
    const maxPage = $(baseHtml).find('#main > div.pageNavigation > ul > li:nth-last-child(2) > a').text().replace(/[^0-9]/g, '');
    for (let pageNo = 1; pageNo <= maxPage; pageNo++) {
        const pageHtml = await getHtml(`${baseUrl}&pageNo=${pageNo}`);
        const aUserprofiles = $(pageHtml).find('#main > div.tabMenuContent > table.membersList > tbody > tr > td.columnUsername > div.containerContentSmall > p > a');
        for (let userprofileIndex = 0; userprofileIndex < aUserprofiles.length; userprofileIndex++) {
            const aUserprofile = aUserprofiles[userprofileIndex];
            const progressString = `members, page ${pageNo}/${maxPage}, userprofile ${userprofileIndex + 1}/${aUserprofiles.length}`;
            log(progressString);
            await downloadUserprofile(aUserprofile.href, aUserprofile.text, progressString);
        }
    }
    log(maxPage);
}

process.on('exit', () => {
    db.close();
    log('exit');
});
(async function main() {
    log('starting');
    await iterateBoards(rootUrl, '.', 'root');
    await iterateMemberslist();
}());
