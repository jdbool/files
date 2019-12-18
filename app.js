const config = require('./config.json');

const path = require('path');
const fs = require('fs').promises;

const prettySize = require('prettysize');
const chalk = require('chalk');
const logSymbols = require('log-symbols');
const express = require('express');
const fileUpload = require('express-fileupload');
const rateLimit = require('express-rate-limit');
const basicAuth = require('express-basic-auth');
const handlebars = require('express-handlebars');
const bodyParser = require('body-parser');
const { check, validationResult } = require('express-validator');
const randomString = require('randomstring');
const send = require('send');
const hasha = require('hasha');

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

mongoose.set('toObject', {
	transform: function (doc, ret) {
		if (ret._id) {
			ret.id = ret._id;
			delete ret._id;
		}
		if (ret.__v)
			delete ret.__v;
	}
});

const fileSchema = new Schema({
	_id: String,
	deleted: Boolean,
	token: { type: String, ref: 'Token' },
	type: { type: String },
	size: Number,
	hits: Number,
	botHits: Number,
	ip: String,
	deleteKey: String,
	hash: String,
	originalName: String
}, {
	_id: false,
	timestamps: true
});

const tokenSchema = new Schema({
	_id: String,
	deleted: Boolean,
	files: [
		{ type: String, ref: 'File' }
	],
	uploadedBytes: Number,
	allowedBytes: Number,
	details: String
}, {
	_id: false,
	timestamps: true
});

const File = mongoose.model('File', fileSchema);
const Token = mongoose.model('Token', tokenSchema);

const app = express();
app.set('trust proxy', 'loopback');

app.use(fileUpload({
	useTempFiles: true,
	tempFileDir: process.platform == 'win32' ? 'C:/temp/' : '/tmp/'
}));

app.use(bodyParser.json());

app.engine('handlebars', handlebars.create({
	helpers: {
		prettySize
	},
	defaultLayout: false
}).engine);
app.set('view engine', 'handlebars');
if (!config.noCache)
	app.enable('view cache');
app.set('views', path.join(__dirname, 'views'));

const uploadsPath = id => path.join(__dirname, 'uploads', id);

const problem = (req, res, error) => {
	res.status(error.status);
	if (req.accepts('html')) {
		res.render('error', error);
	} else {
		// Object with a property called 'error'
		res.json({
			error
		});
	}
};

app.get('/robots.txt', (req, res) => {
	res.set('Content-Type', 'text/plain').send('User-agent: *\nDisallow: /');
});

const noValidationProblems = (req, res, next) => {
	const problems = validationResult(req);
	if (!problems.isEmpty()) {
		problem(req, res, {
			status: 422,
			title: 'Unprocessable Entity',
			detail: 'Invalid body given',
			problems: problems.array()
		});
		return;
	}
	next();
};

app.use('/admin*', basicAuth({
	users: config.adminUsers,
	challenge: true,
	realm: 'files-admin'
}));

app.get('/admin', async (req, res) => {
	const files = await File.find().exec();
	const tokens = await Token.find().exec();
	res.render('admin', {
		files: files.map(file => file.toObject()),
		tokens: tokens.map(token => token.toObject())
	});
});

app.post('/admin/tokens', [
	check('allowedBytes').optional().isInt(),
	check('details').optional().isString()
], noValidationProblems, async (req, res) => {
	const token = new Token({
		_id: randomString.generate(32),
		deleted: false,
		files: [],
		uploadedBytes: 0,
		allowedBytes: req.body.allowedBytes || null,
		details: req.body.details || null
	});

	await token.save();

	const obj = token.toObject();
	delete obj.__v;

	res.json(obj);
});

app.delete('/admin/tokens', [
	check('id').isString()
], noValidationProblems, async (req, res) => {
	const token = await Token.findOne({
		_id: req.body.id,
		deleted: false
	}, '_id deleted files uploadedBytes allowedBytes details createdAt updatedAt').exec();
	if (!token) {
		problem(req, res, {
			status: 404,
			title: 'Not Found',
			detail: 'No token with that ID'
		});
		return;
	}

	token.deleted = true;
	await token.save();

	res.json(token.toObject());
});

app.post('/upload', rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 10,
	message: {
		error: {
			status: 429,
			title: 'Too Many Requests',
			detail: 'You are uploading too many files'
		}
	}
}), async (req, res) => {
	const tokenID = req.get('Authorization');

	const token = await Token.findOne({
		_id: tokenID,
		deleted: false
	}, '_id uploadedBytes allowedBytes').exec();
	if (!token) {
		problem(req, res, {
			status: 401,
			title: 'Unauthorized',
			detail: 'No authorized token given'
		});
		return;
	}

	const upload = req.files.file;
	
	if (!upload) {
		problem(req, res, {
			status: 400,
			title: 'Bad Request',
			detail: 'No file given'
		});
		return;
	}

	if (token.allowedBytes && upload.size + token.uploadedBytes > token.allowedBytes) {
		problem(req, res, {
			status: 403,
			title: 'Forbidden',
			detail: "Exceeds token's allowed storage space"
		});
		return;
	}

	try {
		let id;

		// eslint-disable-next-line no-constant-condition
		while (true) {
			id = randomString.generate(7);

			if (id.startsWith('admin'))
				continue;

			if (!(await File.exists({ _id: id })))
				break;
		}

		const hash = await hasha.fromFile(upload.tempFilePath, { algorithm: 'md5' });

		await fs.rename(upload.tempFilePath, uploadsPath(id));

		const file = new File({
			_id: id,
			deleted: false,
			token: token._id,
			type: upload.mimetype,
			size: upload.size,
			hits: 0,
			botHits: 0,
			ip: req.ip,
			deleteKey: randomString.generate(64),
			hash,
			originalName: upload.name
		});

		await file.save();

		await Token.findByIdAndUpdate(token._id, {
			$inc: {
				uploadedBytes: upload.size
			},
			$push: {
				files: file._id
			}
		}).exec();
	
		res.json(file.toObject());
	
		console.log(chalk.green('[Upload] ') + `${file._id} - ${file.type} by ${file.ip} (${tokenID.substr(0, 8)}...)`);
	} catch (err) {
		problem(req, res, {
			status: 500,
			title: 'Internal Server Error',
			detail: err.message
		});
		console.log(chalk.red('[Upload] ') + `Unable to upload:\n\t${err}`);
	}
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

app.get('/:id', rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 100,
	message: {
		error: {
			status: 429,
			title: 'Too Many Requests',
			detail: 'You are requesting too many files'
		}
	}
}), async (req, res) => {
	const file = await File.findOne({
		_id: req.params.id,
		deleted: false
	}, '_id type').exec();
	if (!file) {
		problem(req, res, {
			status: 404,
			title: 'Not Found',
			detail: 'No file with that ID'
		});
		return;
	}

	res.set('Content-Type', file.type);
	res.set('Cache-Control', 'public, max-age=31536000');

	try {
		send(req, uploadsPath(file._id)).pipe(res);
	} catch (err) {
		problem(req, res, {
			status: 500,
			title: 'Internal Server Error',
			detail: 'Could not send file'
		});
		return;
	}

	if (!req.get('Range')) {
		if (!req.get('User-Agent') || !req.get('Accept') || req.get('User-Agent').toLowerCase().includes('bot')) {
			await File.findByIdAndUpdate(file._id, { $inc: { botHits: 1 } }).exec();
			console.log(chalk.cyan('[Bot Hit] ') + `${file._id} - ${req.ip} - ${req.get('User-Agent')}`);
		} else {
			await File.findByIdAndUpdate(file._id, { $inc: { hits: 1 } }).exec();
			console.log(chalk.blue('[Hit] ') + `${file._id} - ${req.ip}`);
		}
	}
});

app.get('/delete/:id/:deleteKey', rateLimit({
	windowMs: 15 * 60 * 1000,
	max: 10,
	message: {
		error: {
			status: 429,
			title: 'Too Many Requests',
			detail: 'You are deleting too many files'
		}
	}
}), async (req, res) => {
	const file = await File.findOne({
		_id: req.params.id,
		deleteKey: req.params.deleteKey,
		deleted: false
	}).exec();
	if (!file) {
		problem(req, res, {
			status: 404,
			title: 'Not Found',
			detail: 'No file with that ID or deleteKey'
		});
		return;
	}

	file.deleted = true;
	await file.save();
	
	await Token.findByIdAndUpdate(file.token, {
		$inc: {
			uploadedBytes: -file.size
		}
	}).exec();

	if (req.accepts('html')) {
		res.render('deleted');
	} else {
		res.json(file.toObject());
	}
	
	try {
		await fs.unlink(uploadsPath(file._id));
		console.log(chalk.yellow('[Delete] ') + file._id);
	} catch (err) {
		console.log(chalk.red('[Delete] ') + `${file._id}, unable to erase data\n\t${err}`);
	}
});

app.use((req, res) => {
	problem(req, res, {
		status: 404,
		title: 'Not Found',
		detail: 'Endpoint does not exist'
	});
});

(async () => {
	console.log('Starting...');

	try {
		await mongoose.connect(config.mongoURL, Object.assign({
			useNewUrlParser: true,
			useUnifiedTopology: true,
			useFindAndModify: false
		}, config.mongoSettings));
		console.log(logSymbols.success, 'MongoDB connected');
	} catch (err) {
		console.log(logSymbols.error, `MongoDB connection failed: ${err.message}`);
		return;
	}

	app.listen(config.port, () => {
		console.log(logSymbols.success, `HTTP listening on port ${config.port}`);
	});
})();