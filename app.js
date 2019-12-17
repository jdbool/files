const config = require('./config.json');

const path = require('path');
const fs = require('fs').promises;

const prettySize = require('prettysize');
const chalk = require('chalk');
const Sequelize = require('sequelize');
const express = require('express');
const fileUpload = require('express-fileupload');
const rateLimit = require('express-rate-limit');
const basicAuth = require('express-basic-auth');
const handlebars = require('express-handlebars');
const randomString = require('randomstring');
const send = require('send');
const hasha = require('hasha');

const db = new Sequelize({
	dialect: 'sqlite',
	storage: path.join(__dirname, 'files.db'),
	logging: false
});

const File = db.define('file', {
	id: {
		type: Sequelize.STRING(7),
		primaryKey: true
	},
	type: Sequelize.STRING,
	size: Sequelize.INTEGER,
	hits: {
		type: Sequelize.INTEGER,
		defaultValue: 0
	},
	botHits: {
		type: Sequelize.INTEGER,
		defaultValue: 0
	},
	ip: Sequelize.STRING,
	deleteKey: Sequelize.STRING(64),
	hash: Sequelize.STRING(64),
	originalName: Sequelize.STRING
});

const app = express();
app.set('trust proxy', 'loopback');

app.use(fileUpload({
	useTempFiles: true,
	tempFileDir: process.platform == 'win32' ? 'C:/temp/' : '/tmp/'
}));

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

app.get('/admin', basicAuth({
	users: config.adminUsers,
	challenge: true,
	realm: 'files-admin'
}), async (req, res) => {
	const files = await File.findAll();
	res.render('admin', {
		files
	});
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
	const token = req.get('Authorization');

	if (!config.tokens.includes(token)) {
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

	try {
		let id;

		// eslint-disable-next-line no-constant-condition
		while (true) {
			id = randomString.generate(7);
			const used = await File.findByPk(id);
			if (!used) break;
		}

		const hash = await hasha.fromFile(upload.tempFilePath, { algorithm: 'md5' });

		await fs.rename(upload.tempFilePath, uploadsPath(id));

		const file = await File.create({
			id,
			type: upload.mimetype,
			size: upload.size,
			ip: req.ip,
			deleteKey: randomString.generate(64),
			hash,
			originalName: upload.name
		});
	
		res.json({
			id: file.id,
			type: file.type,
			size: file.size,
			ip: file.ip,
			deleteKey: file.deleteKey,
			hash: file.hash,
			originalName: file.originalName
		});
	
		console.log(chalk.green('[Upload] ') + `${file.id} - ${file.type} by ${file.ip} (${token.substr(0, 8)}...)`);
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
	const file = await File.findByPk(req.params.id);
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

	if (!req.get('Range')) {
		if (!req.get('User-Agent') || !req.get('Accept') || req.get('User-Agent').toLowerCase().includes('bot')) {
			await file.increment('botHits', { by: 1 });
			console.log(chalk.cyan('[Bot Hit] ') + `${file.id} - ${req.ip} - ${req.get('User-Agent')}`);
		} else {
			await file.increment('hits', { by: 1 });
			console.log(chalk.blue('[Hit] ') + `${file.id} - ${req.ip}`);
		}
	}

	try {
		send(req, uploadsPath(file.id)).pipe(res);
	} catch (err) {
		problem(req, res, {
			status: 500,
			title: 'Internal Server Error',
			detail: 'Could not send file'
		});
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
		where: req.params
	});

	if (!file) {
		problem(req, res, {
			status: 404,
			title: 'Not Found',
			detail: 'No file with that ID or deleteKey'
		});
		return;
	}

	if (req.accepts('html')) {
		res.render('deleted');
	} else {
		res.json({
			deleted: true,
			type: file.type,
			size: file.size,
			ip: file.ip,
			hits: file.hits,
			botHits: file.botHits
		});
	}

	await file.destroy();
	
	try {
		await fs.unlink(uploadsPath(file.id));
		console.log(chalk.yellow('[Delete] ') + file.id);
	} catch (err) {
		console.log(chalk.red('[Delete] ') + `${file.id}, unable to erase data\n\t${err}`);
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
	await db.sync();

	app.listen(config.port, () => {
		console.log(`HTTP listening on port ${config.port}`);
	});
})();