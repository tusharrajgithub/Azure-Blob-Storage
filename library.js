"use strict";

var plugin = {},
	azure = require("azure-storage"),
	mime = require("mime"),
	uniqid = require("uniqid"),
	fs = require("fs"),
	request = require("request"),
	path = require("path"),
	im = require('imagemagick-stream'),
	async = require.main.require('async'),
	winston = module.parent.require("winston"),
	nconf = module.parent.require('nconf'),
	meta = module.parent.require("./meta"),
	db = module.parent.require("./database");
	const dotenv = require('dotenv');
    dotenv.config();


var settings = {
	accessKeyId: false,
	secretAccessKey: false,
	container: process.env.AZURE_STORAGE_CONTAINER,
	host:process.env.AZURE_STORAGE_HOSTNAME,
	path:undefined,
	storageAccessKey:process.env.AZURE_STORAGE_ACCESS_KEY,
	storageAccount:process.env.AZURE_STORAGE_ACCOUNT,
	connectionString: `DefaultEndpointsProtocol=https;AccountName=${process.env.AZURE_STORAGE_ACCOUNT};AccountKey=${process.env.AZURE_STORAGE_ACCESS_KEY};EndpointSuffix=core.windows.net`
};

var accessKeyIdFromDb = false;
var secretAccessKeyFromDb = false;

var blobSvc = null;

plugin.activate = function (data) {
	if (data.id === 'nodebb-plugin-azurestorage') {
		fetchSettings();
	}

};

plugin.deactivate = function (data) {
	if (data.id === 'nodebb-plugin-azurestorage') {
		blobSvc = null;
	}
};

plugin.load = function (params, callback) {
	fetchSettings(function (err) {
		if (err) {
			return winston.error(err.message);
		}
		var adminRoute = "/admin/plugins/azurestorage";

		params.router.get(adminRoute, params.middleware.applyCSRF, params.middleware.admin.buildHeader, renderAdmin);
		params.router.get("/api" + adminRoute, params.middleware.applyCSRF, renderAdmin);

		params.router.post("/api" + adminRoute + "/assettings", assettings);
		params.router.post("/api" + adminRoute + "/credentials", credentials);
		params.router.get("/api/downloads/sasgenerator/",sasGenerator);

		callback();
	});
};

function renderAdmin(req, res) {
    	// Regenerate csrf token
	var token = req.csrfToken();

	var forumPath = nconf.get('url');
	if(forumPath.split("").reverse()[0] != "/" ){
		forumPath = forumPath + "/";
	}
	var data = {
		container: settings.container,
		host: settings.host,
		path: settings.path,
		forumPath: forumPath,
		accessKeyId: (accessKeyIdFromDb && settings.accessKeyId) || "",
		secretAccessKey: (accessKeyIdFromDb && settings.secretAccessKey) || "",
		csrf: token
	};

	res.render("admin/plugins/azurestorage", data);
}

function fetchSettings(callback) {
	db.getObjectFields("nodebb-plugin-azurestorage", Object.keys(settings), function (err, newSettings) {
		if (err) {
			winston.error(err.message);
			if (typeof callback === "function") {
				callback(err);
			}
			return;
		}

		accessKeyIdFromDb = false;
		secretAccessKeyFromDb = false;

		if (newSettings.accessKeyId) {
			settings.accessKeyId = newSettings.accessKeyId;
			accessKeyIdFromDb = true;
		} else {
			settings.accessKeyId = false;
		}

		if (newSettings.secretAccessKey) {
			settings.secretAccessKey = newSettings.secretAccessKey;
			secretAccessKeyFromDb = false;
		} else {
			settings.secretAccessKey = false;
		}

		if (!newSettings.container) {
			settings.container = process.env.AZURE_STORAGE_CONTAINER || "";
		} else {
			settings.container = newSettings.container;
		}

		if (!newSettings.host) {
			settings.host = process.env.AZURE_STORAGE_HOSTNAME || "";
		} else {
			settings.host = newSettings.host;
		}

		// if (!newSettings.path) {
		// 	settings.path = process.env.AZURE_STORAGE_PATH || "";
		// } else {
		// 	settings.path = newSettings.path;
		// }

		if (settings.accessKeyId && settings.secretAccessKey) {
			blobSvc = azure.createBlobService(settings.accessKeyId, settings.secretAccessKey);
		}

		if (typeof callback === "function") {
			callback();
		}
	});
}

function Blob() {
	if (!blobSvc) {
		blobSvc = azure.createBlobService(settings.storageAccount,settings.storageAccessKey);
		console.log("created blob") // using env AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_ACCESS_KEY
	}

	return blobSvc;
}

function makeError(err) {
	if (err instanceof Error) {
		err.message = "nodebb-plugin-azurestorage:: " + err.message;
	} else {
		err = new Error("nodebb-plugin-azurestorage:: " + err);
	}

	winston.error(err.message);
	return err;
}

function assettings(req, res, next) {
	var data = req.body;
	var newSettings = {
		container: data.container || "",
		host: data.host || "",
		path: data.path || ""
	};

	saveSettings(newSettings, res, next);
}

function credentials(req, res, next) {
	var data = req.body;
	var newSettings = {
		accessKeyId: data.accessKeyId || "",
		secretAccessKey: data.secretAccessKey || ""
	};

	saveSettings(newSettings, res, next);
}

function saveSettings(settings, res, next) {
	db.setObject("nodebb-plugin-azurestorage", settings, function (err) {
		if (err) {
			return next(makeError(err));
		}

		fetchSettings();
		res.json("Saved!");
	});
}



plugin.uploadImage = function (data, callback) {
	async.waterfall([
		function(next) {
			var image = data.image;
			if (!image) {
				return next(new Error("[[error:invalid-image]]"));
			}
			if (image.size > parseInt(meta.config.maximumFileSize, 10) * 1024) {
				winston.error("error:file-too-big, " + meta.config.maximumFileSize );
				return next(new Error("[[error:file-too-big, " + meta.config.maximumFileSize + "]]"));
			}
			next(null, image);
		},
		function(_image, next) {
			var image = _image;
			var type = image.url ? "url" : "file";
			var allowedMimeTypes = ['image/png', 'image/jpeg', 'image/gif'];
			if (type === "file") {
				if (!image.path) {
					return next(new Error("invalid image path"));
				}
		
				if (allowedMimeTypes.indexOf(mime.getType(image.path)) === -1) {
					return next(new Error("invalid mime type"));
				}
				var rs = fs.createReadStream(image.path);
				next(null, rs, image.name);
			}
			else {
				if (allowedMimeTypes.indexOf(mime.getType(image.url)) === -1) {
					return next(new Error("invalid mime type"));
				}
				var filename = image.url.split("/").pop();
		
				var imageDimension = parseInt(meta.config.profileImageDimension, 10) || 128;
		
				var resize = im().resize(imageDimension + "^", imageDimension + "^");
				var imstream = request(image.url).pipe(resize);
				next(null, imstream, image.name);
			}
		},
		function(_rs, _name, next) {
			uploadToAzureStorage(_name, _rs, next);
		}
	], callback);
};

plugin.uploadFile = function (data, callback) {
	async.waterfall([
		function(next) {
			var file = data.file;	
			if (!file) {
				return next(new Error("[[error:invalid-file]]"));
			}
		
			if (!file.path) {
				return next(new Error("[[error:invalid-file-path]]"));
			}
			next(null, file);
		},
		function(_file, next) {
			var file = _file;
			if (file.size > parseInt(meta.config.maximumFileSize, 10) * 1024) {
				winston.error("error:file-too-big, " + meta.config.maximumFileSize );
				return next(new Error("[[error:file-too-big, " + meta.config.maximumFileSize + "]]"));
			}
			next(null, file);
		},
		function(_file, next) {
			var rs = fs.createReadStream(_file.path);
			next(null, rs, _file.name);
		},
		function(_rs, _name, next) {
			uploadToAzureStorage(_name, _rs, next);
		}
	], callback);
};

function uploadToAzureStorage(filename, rs, callback) {
	async.waterfall([
		function(next) {
			var azPath;
			if (settings.path && 0 < settings.path.length) {
				azPath = settings.path;
		
				if (!azPath.match(/\/$/)) {
					// Add trailing slash
					azPath = azPath + "/";
				}
			}
			else {
				azPath = "/";
			}
			var azKeyPath = azPath.replace(/^\//, "");
			var ename = path.extname(filename);
			var oname = path.basename(filename, ename);
			oname = oname.replace(/\ /g, "_");

			var key = azKeyPath + uniqid.time(oname + '-') + ename ;
			next(null, key);
		},
		function(key, next)
		{
			var host = "https://" + settings.accessKeyId +".blob.core.windows.net/" + settings.container;
			if (settings.host && 0 < settings.host.length) {
				host = settings.host;
			}
			next(null, key, host);
		},
		function(key, host, next)
		{
			var options = {
				contentSettings: {
					contentType: mime.getType(filename)
				}
			};
			rs.pipe(Blob().createWriteStreamToBlockBlob(settings.container, key, function(err, result, resp) {
				if (err) {
					return next(err);
				}
			})).on('finish', function(err) {
				if (err) {
					return (next(makeError(err)));
				}
				var response = {
					name: filename,
					url:"/api/downloads/sasgenerator?key="+key
					//url:"https://" + host + "/nodebb/" + key				
				};

				next(null, response);
			});
		}
	], callback);
}

plugin.menu = function (custom_header, callback) {
	custom_header.plugins.push({
		"route": "/plugins/azurestorage",
		"icon": "fa-envelope-o",
		"name": "Azure Storage"
	});

	callback(null, custom_header);
};

function sasGenerator(req,res,next)
{
	var docName = req.query.key;
	var startDate = new Date();
	var expiryDate = new Date(startDate);
	expiryDate.setMinutes(startDate.getMinutes() + 5);
	startDate.setMinutes(startDate.getMinutes() - 5);

	var sharedAccessPolicy = {
		AccessPolicy: {
			Permissions: azure.BlobUtilities.SharedAccessPermissions.READ,
			Start: startDate,
			Expiry: expiryDate
		}
	};
    Blob()
	var token = blobSvc.generateSharedAccessSignature(settings.container, docName, sharedAccessPolicy);
	var sasUrl = blobSvc.getUrl(settings.container, docName, token);
	res.redirect(sasUrl);
}

module.exports = plugin;