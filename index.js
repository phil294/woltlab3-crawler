const $ = require('jquery');
const fetch = require('node-fetch');
const fs = require('fs');

const l = console.log;

const baseUrl = 'http://regnum.gamigo.com/de/forum/index.php?page=Index';

async function getHtml(url) {
    const res = await fetch(url);
    const html = await res.text();
    return html;
}
async function saveUrl(url, filename) {
    const res = await fetch(url);
    const stream = fs.createWriteStream(filename);
    res.body.pipe(stream);
}

/** main */
(async () => {
    const html = await getHtml(baseUrl);
    l(html);
})();
