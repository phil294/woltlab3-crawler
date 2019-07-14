- tested with woltlab burning board 3.1.8, probably also works with 2.1.2 pl 1
- `yarn install`, then `node crawler.js [wcf_cookieHash] [User-Agent] [root_dir]`, for example `node crawler.js 0929e19bf86e9ae1664310447558481638e3ff92 'Mozilla/5.0 (X11; Linux x86_64) Safari/537.36' 'https://cor-forum.de'` (see request header of page load)
- user of belonging session should have maximum post and thread length enabled in options
- create folder attachments and userprofilepics beforehand
- output = sqlite database and attachments folder
- database: will have tables threads (id INTEGER PRIMARY KEY ASC, path TEXT) and posts (id INTEGER PRIMARY KEY ASC, thread INTEGER, user INTEGER, username TEXT, timestamp INTEGER, message TEXT)
- prints progress like `root, board 1/19, board 1/1, page 1/2, thread 3/49, page 1/1, 2 posts`

Note: The package.json is outdated and contains possibly vulnerable dependencies. Check before use or simply upgrade the deps.
