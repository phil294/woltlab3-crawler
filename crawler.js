const $ = require('jquery');
const fetch = require('node-fetch');
const html2plaintext = require('html2plaintext');
const fs = require('fs');

const { log, error } = console;

const args = process.argv.slice(2);
if (args.length !== 3) {
    error('call: program [index.php] [wcf_cookieHash] [User-Agent]');
    error('example: node crawler.js 0929e19bf86e9ae1664310447558481638e3ff92 \'Mozilla/5.0 (X11; Linux x86_64) Safari/537.36\' \'http://regnum.gamigo.com/de/forum\'');
    process.exit(1);
}
const headers = {
    'Cache-Control': 'max-age=0',
    Cookie: `wcf_cookieHash=${args[0]}`,
    'User-Agent': args[1],
};
const baseUrl = args[2];

async function getRes(url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
        log(url, res.statusText, 'See error code for returned http status.');
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

/** main */
(async () => {
    saveUrl(baseUrl, 'tmp');
    const html = await getHtml(baseUrl);
    const text = html2plaintext(html);
    log(text);

    log('finished');
})();
