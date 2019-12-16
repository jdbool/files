# files
Simple file hosting server for Node.js. Stores file information in an SQLite database and uploads in the file system.

# Usage
There's no way to upload via a browser yet, it's designed for tools like [ShareX](https://getsharex.com/).

## Uploading
**POST /upload**

The `Authorization` header has to be a valid token, and the file should be called `file` (multipart/form-data).

Response (if OK, else there will be an `error` object):
```js
{
	// 7 character long file ID
	"id": String,
	// MIME type
	"type": String,
	// Size in bytes
	"size": Number,
	// The IP you uploaded from
	"ip": String,
	// 64 character long key that can be used to delete the file
	"deleteKey": String,
	// MD5 file hash
	"hash": String,
	// Name of the file you uploaded
	"originalName": String
}
```

The file will then be accessible at `GET /{id}`.

## Deleting
**GET /delete/{id}/{deleteKey}**

Uses GET so the link can be opened in a browser. If the request doesn't accept HTML, and OK response would be:
```js
{
	"deleted": true,
	"type": String,
	"size": Number,
	"ip": String,
	// How many times the file was sent to a human (unless they lied)
	"hits": Number,
	// How many times it was sent to a bot
	"botHits": Number
}
```

## Admin
**GET /admin** in a browser

It'll prompt for a username and password and show all uploaded files.

# Configuration
`config.json` has to be created. Example:
```js
{
	"port": 3020,
	"adminUsers": {
		"username": "password",
		...
	},
	"tokens": [
		"alonguniquethinghere",
		...
	]
}
```