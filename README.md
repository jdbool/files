# files
Simple file hosting server for Node.js. Stores file information in MongoDB and uploads in the file system.

# Usage
Visiting `/` in a browser shows a single page where you can enter your token and upload files.

## Admin
`/admin` in a browser will prompt for a username and password, and allows control of tokens and uploaded files.

# API

## Error Response
```js
{
	"error": {
		"status": Number,
		"title": String,
		"detail": String
	}
}
```

## Uploading
**POST /upload**

The `Authorization` header has to be a valid token, and the file should be called `file` (multipart/form-data).

Response (if OK):
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

Uses GET so the link can be opened in a browser. If the request doesn't accept HTML, an OK response would be:
```js
{
	"deleted": true,
	"type": String,
	"size": Number,
	"ip": String,
	// How many times the file was sent to a human (unless a bot was disguised as a browser)
	"hits": Number,
	// How many times it was sent to a bot
	"botHits": Number
}
```

# Configuration
`config.json` has to be created. Example:
```js
{
	"port": 3020,
	// Logins authorized to access /admin
	"adminUsers": {
		"username": "password",
		...
	},
	"mongoURL": "mongodb://localhost:27017/files",
	// Additional settings when connecting with mongoose
	"mongoSettings": {
		"auth": { "authSource": "admin" },
		"user": "GeoGrumbler59",
		"pass": "myawesomepassword"
	}
}
```