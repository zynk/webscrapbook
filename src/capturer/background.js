/********************************************************************
 *
 * The background script for capture functionality
 *
 * @require {boolean} isDebug
 * @require {Object} scrapbook
 * @require {Object} capturer
 *******************************************************************/

capturer.isContentScript = false;

capturer.defaultFilesSet = new Set(["index.rdf", "index.dat"]);

/**
 * @type {Map<string~timeId, {files: Set<string>, accessMap: Map<string, Promise>, zip: JSZip}>}
 */
capturer.captureInfo = new Map();

/**
 * @type {Map<string~downloadId, {timeId: string, src: string, autoErase: boolean, onComplete: function, onError: function}>}
 */
capturer.downloadInfo = new Map();

/**
 * Gets a unique token for an access,
 * to be used in capturer.captureInfo.get(timeId).accessMap
 *
 * @param {string} method - The rewrite method name of how the URL is used
 *     (i.e. as embedded file, as stylesheet, or as (headless) document).
 */
capturer.getAccessToken = function (url, method) {
  var token = scrapbook.splitUrlByAnchor(url)[0] + "\t" + (method || "");
  token = scrapbook.sha1(token, "TEXT");
  return token;
};

/**
 * Prevent filename conflict. Appends a number if the given filename is used.
 *
 * @param {string} timeId
 * @param {string} filename - The unfixed filename. Should be validated (via scrapbook.validateFilename).
 * @return {string} The fixed filename.
 */
capturer.getUniqueFilename = function (timeId, filename) {
  if (!capturer.captureInfo.has(timeId)) { capturer.captureInfo.set(timeId, {}); }
  var files = capturer.captureInfo.get(timeId).files = capturer.captureInfo.get(timeId).files || new Set(capturer.defaultFilesSet);

  var newFilename = filename || "untitled";
  var [newFilenameBase, newFilenameExt] = scrapbook.filenameParts(newFilename);
  newFilenameBase = scrapbook.crop(scrapbook.crop(newFilenameBase, 240, true), 128);
  newFilenameExt = newFilenameExt ? "." + newFilenameExt : "";

  var newFilename = newFilenameBase + newFilenameExt,
      newFilenameCI = newFilename.toLowerCase(),
      count = 0;
  while (files.has(newFilenameCI)) {
    newFilename = newFilenameBase + "-" + (++count) + newFilenameExt;
    newFilenameCI = newFilename.toLowerCase(); 
  }
  files.add(newFilenameCI);
  return newFilename;
};

/**
 * @kind invokable
 * @param {Object} params
 *     - {string} params.mode
 * @return {Promise}
 */
capturer.captureActiveTab = function (params) {
  return Promise.resolve().then(() => {
    var {mode} = params;

    return new Promise((resolve, reject) => {
      chrome.tabs.query({active: true, currentWindow: true}, resolve);
    }).then((tabs) => {
      return capturer.captureTab({tab: tabs[0], mode: mode});
    });
  });
};

/**
 * @kind invokable
 * @param {Object} params
 *     - {string} params.mode
 * @return {Promise}
 */
capturer.captureAllTabs = function (params) {
  return Promise.resolve().then(() => {
    var {mode} = params;

    capturer.getContentTabs().then((tabs) => {
      var ms = -100;
      return Promise.all(tabs.map((tab) => {
        return scrapbook.delay(ms += 100).then(() => {
          return capturer.captureTab({tab: tab, mode: mode});
        });
      }));
    });
  });
};

/**
 * @kind invokable
 * @param {Object} params
 *     - {Object} params.tab
 *     - {string} params.mode
 * @return {Promise}
 */
capturer.captureTab = function (params) {
  return new Promise((resolve, reject) => {
    var {tab, mode} = params,
        {id: tabId, url: tabUrl, favIconUrl: tabFavIconUrl} = tab;

    var source = "[" + tabId + "] " + tabUrl;
    var timeId = scrapbook.dateToId();
    var message = {
      url: tabUrl,
      settings: {
        timeId: timeId,
        frameIsMain: true,
        documentName: "index",
        recurseChain: [],
      },
      options: capturer.fixOptions(scrapbook.getOptions("capture"))
    };

    return Promise.resolve().then(() => {
      isDebug && console.debug("(main) send", source, message);
      switch (mode) {
        case "bookmark":
          return capturer.captureBookmark(message);
        case "source":
          return capturer.captureUrl(message);
        case "document":
        default:
          message.settings.favIconUrl = tabFavIconUrl;
          return capturer.invoke("captureDocumentOrFile", message, tabId);
      }
    }).then((response) => {
      isDebug && console.debug("(main) response", source, response);
      capturer.captureInfo.delete(timeId);
      if (!response) {
        throw new Error(scrapbook.lang("ErrorContentScriptNotReady"));
      } else if (response.error) {
        throw new Error(scrapbook.lang("ErrorCaptureGeneral"));
      }
      return response;
    }).catch((ex) => {
      var err = scrapbook.lang("ErrorCapture", [source, ex.message]);
      console.error(err);
      capturer.browserActionAddError();
      return new Error(err);
    });
  });
};

/**
 * @kind invokable
 * @param {Object} params
 *     - {string} params.url
 *     - {string} params.refUrl
 *     - {Object} params.settings
 *     - {Object} params.options
 * @return {Promise}
 */
capturer.captureUrl = function (params) {
  return Promise.resolve().then(() => {
    isDebug && console.debug("call: captureUrl", params);

    var {url: sourceUrl, refUrl, settings, options} = params,
        [sourceUrlMain] = scrapbook.splitUrlByAnchor(sourceUrl),
        {timeId} = settings;

    var headers = {};

    // init access check
    if (!capturer.captureInfo.has(timeId)) { capturer.captureInfo.set(timeId, {}); }
    var accessMap = capturer.captureInfo.get(timeId).accessMap = capturer.captureInfo.get(timeId).accessMap || new Map();

    // check for previous access
    var rewriteMethod = "captureUrl";
    var accessToken = capturer.getAccessToken(sourceUrlMain, rewriteMethod);
    var accessPrevious = accessMap.get(accessToken);
    if (accessPrevious) { return accessPrevious; }

    let requestHeaders = {};
    if (refUrl) { requestHeaders["X-WebScrapBook-Referer"] = refUrl; }

    var accessCurrent = new Promise((resolve, reject) => {
      scrapbook.xhr({
        url: sourceUrl.startsWith("data:") ? scrapbook.splitUrlByAnchor(sourceUrl)[0] : sourceUrl,
        responseType: "document",
        requestHeaders: requestHeaders,
        onreadystatechange: function (xhr, xhrAbort) {
          if (xhr.readyState === 2) {
            // check for previous access if redirected
            let [responseUrlMain] = scrapbook.splitUrlByAnchor(xhr.responseURL);
            if (responseUrlMain !== sourceUrlMain) {
              var accessToken = capturer.getAccessToken(responseUrlMain, rewriteMethod);
              var accessPrevious = accessMap.get(accessToken);
              if (accessPrevious) {
                resolve(accessPrevious);
                xhrAbort();
                return;
              }
              accessMap.set(accessToken, accessCurrent);
            }

            // get headers
            if (xhr.status !== 0) {
              let headerContentDisposition = xhr.getResponseHeader("Content-Disposition");
              if (headerContentDisposition) {
                let contentDisposition = scrapbook.parseHeaderContentDisposition(headerContentDisposition);
                headers.isAttachment = (contentDisposition.type === "attachment");
                headers.filename = contentDisposition.parameters.filename;
              }
              let headerContentType = xhr.getResponseHeader("Content-Type");
              if (headerContentType) {
                let contentType = scrapbook.parseHeaderContentType(headerContentType);
                headers.contentType = contentType.type;
                headers.charset = contentType.parameters.charset;
              }
            }

            // generate a documentName if not specified
            if (!params.settings.documentName) {
              // use the filename if it has been defined by header Content-Disposition
              let filename = headers.filename ||
                  sourceUrl.startsWith("data:") ?
                      scrapbook.dataUriToFile(scrapbook.splitUrlByAnchor(sourceUrl)[0]).name :
                      scrapbook.urlToFilename(sourceUrl);

              let mime = headers.contentType || Mime.prototype.lookup(filename) || "text/html";
              let fn = filename.toLowerCase();
              if (["text/html", "application/xhtml+xml"].indexOf(mime) !== -1) {
                let exts = Mime.prototype.allExtensions(mime);
                for (let i = 0, I = exts.length; i < I; i++) {
                  let ext = ("." + exts[i]).toLowerCase();
                  if (fn.endsWith(ext)) {
                    filename = filename.slice(0, -ext.length);
                    break;
                  }
                }
              }

              params.settings.documentName = filename;
            }
          }
        },
        onload: function (xhr, xhrAbort) {
          let doc = xhr.response;
          if (doc) {
            resolve(capturer.captureDocumentOrFile({
              doc: doc,
              refUrl: refUrl,
              settings: settings,
              options: options
            }));
          } else {
            resolve(capturer.captureFile({
              url: params.url,
              refUrl: refUrl,
              settings: params.settings,
              options: params.options
            }));
          }
        },
        onerror: reject
      });
    }).catch((ex) => {
      console.warn(scrapbook.lang("ErrorFileDownloadError", [sourceUrl, ex.message]));
      return {url: capturer.getErrorUrl(sourceUrl, options), error: ex};
    });
    accessMap.set(accessToken, accessCurrent);
    return accessCurrent;
  });
};

/**
 * @kind invokable
 * @param {Object} params
 *     - {string} params.url
 *     - {string} params.refUrl
 *     - {Object} params.settings
 *     - {Object} params.options
 * @return {Promise}
 */
capturer.captureBookmark = function (params) {
  return Promise.resolve().then(() => {
    isDebug && console.debug("call: captureBookmark", params);

    var {url: sourceUrl, refUrl, settings, options} = params,
        [, sourceUrlHash] = scrapbook.splitUrlByAnchor(sourceUrl),
        {timeId} = settings;

    var title;

    let requestHeaders = {};
    if (refUrl) { requestHeaders["X-WebScrapBook-Referer"] = refUrl; }

    return new Promise((resolve, reject) => {
      scrapbook.xhr({
        url: sourceUrl.startsWith("data:") ? scrapbook.splitUrlByAnchor(sourceUrl)[0] : sourceUrl,
        responseType: "document",
        requestHeaders: requestHeaders,
        onload: function (xhr, xhrAbort) {
          let doc = xhr.response;
          if (doc) { title = doc.title; }
          let meta = params.options["capture.recordDocumentMeta"] ? ' data-sb-source-' + timeId + '="' + scrapbook.escapeHtml(sourceUrl) + '"' : "";
          let html = `<!DOCTYPE html>
<html${meta}>
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="0;url=${scrapbook.escapeHtml(sourceUrl)}">
${title ? '<title>' + scrapbook.escapeHtml(title, false) + '</title>\n' : ''}</head>
<body>
Bookmark for <a href="${scrapbook.escapeHtml(sourceUrl)}">${scrapbook.escapeHtml(sourceUrl, false)}</a>
</body>
</html>`;
          resolve(html);
        },
        onerror: reject
      });
    }).then((html) => {
      var ext = ".htm";
      if (options["capture.saveInScrapbook"]) {
        var targetDir = options["capture.scrapbookFolder"] + "/data";
        var filename = timeId + ext;
        var savePrompt = false;
      } else {
        var targetDir = "";
        var filename = (title ? title : scrapbook.urlToFilename(sourceUrl));
        filename = scrapbook.validateFilename(filename, options["capture.saveAsciiFilename"]);
        if (!filename.endsWith(ext)) filename += ext;
        var savePrompt = true;
      }

      return capturer.saveBlob({
        timeId: timeId,
        blob: new Blob([html], {type: "text/html"}),
        directory: targetDir,
        filename: filename,
        sourceUrl: sourceUrl,
        autoErase: false,
        savePrompt: savePrompt
      }).then((filename) => {
        return {timeId: timeId, sourceUrl: sourceUrl, targetDir: targetDir, filename: filename, url: scrapbook.escapeFilename(filename) + sourceUrlHash};
      });
    }).catch((ex) => {
      console.warn(scrapbook.lang("ErrorFileDownloadError", [sourceUrl, ex.message]));
      return {url: capturer.getErrorUrl(sourceUrl, options), error: ex};
    });
  });
};

/**
 * @kind invokable
 * @param {Object} params
 *     - {string} params.url
 *     - {string} params.refUrl
 *     - {{title: string}} params.data
 *     - {Object} params.settings
 *     - {Object} params.options
 * @return {Promise}
 */
capturer.captureFile = function (params) {
  return Promise.resolve().then(() => {
    isDebug && console.debug("call: captureFile", params);

    var {url: sourceUrl, refUrl, data = {}, settings, options} = params,
        {title} = data,
        {timeId} = settings;

    return capturer.downloadFile({
      url: sourceUrl,
      refUrl: refUrl,
      settings: settings,
      options: options
    }).then((response) => {
      if (settings.frameIsMain) {
        let meta = params.options["capture.recordDocumentMeta"] ? ' data-sb-source-' + timeId + '="' + scrapbook.escapeHtml(sourceUrl) + '"' : "";
        // for the main frame, create a index.html that redirects to the file
        let html = `<!DOCTYPE html>
<html${meta}>
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="0;url=${scrapbook.escapeHtml(response.url)}">
${title ? '<title>' + scrapbook.escapeHtml(title, false) + '</title>\n' : ''}</head>
<body>
Redirecting to file <a href="${scrapbook.escapeHtml(response.url)}">${scrapbook.escapeHtml(sourceUrl, false)}</a>
</body>
</html>`;
        return capturer.saveDocument({
          sourceUrl: sourceUrl,
          documentName: settings.documentName,
          settings: settings,
          options: options,
          data: {
            title: title,
            mime: "text/html",
            content: html
          }
        });
      } else {
        return {
          timeId: timeId,
          sourceUrl: sourceUrl,
          targetDir: response.targetDir,
          filename: response.filename,
          url: response.url
        };
      }
    });
  });
};

/**
 * @kind invokable
 * @param {Object} params
 *     - {Object} params.settings
 *     - {Object} params.options
 * @return {Promise}
 */
capturer.registerDocument = function (params) {
  return Promise.resolve().then(() => {
    isDebug && console.debug("call: registerDocument", params);

    var {settings, options} = params,
        {timeId, documentName} = settings;

    if (!capturer.captureInfo.has(timeId)) { capturer.captureInfo.set(timeId, {}); }
    var files = capturer.captureInfo.get(timeId).files = capturer.captureInfo.get(timeId).files || new Set(capturer.defaultFilesSet);

    var newDocumentName = documentName,
        newDocumentNameCI = newDocumentName.toLowerCase(),
        count = 0;
    while (files.has(newDocumentNameCI + ".html") || files.has(newDocumentNameCI + ".xhtml")) {
      newDocumentName = documentName + "_" + (++count);
      newDocumentNameCI = newDocumentName.toLowerCase();
    }
    files.add(newDocumentNameCI + ".html");
    files.add(newDocumentNameCI + ".xhtml");
    return {documentName: newDocumentName};
  });
};

/**
 * @kind invokable
 * @param {Object} params
 *     - {{mime: string, charset: string, content: string, title: string}} params.data
 *     - {string} params.documentName
 *     - {string} params.sourceUrl
 *     - {Object} params.settings
 *     - {Object} params.options
 * @return {Promise}
 */
capturer.saveDocument = function (params) {
  return Promise.resolve().then(() => {
    isDebug && console.debug("call: saveDocument", params);

    var {data, documentName, sourceUrl, settings, options} = params,
        [, sourceUrlHash] = scrapbook.splitUrlByAnchor(sourceUrl),
        {timeId} = settings;

    return Promise.resolve().then(() => {
      switch (options["capture.saveAs"]) {
        case "singleHtml": {
          if (!settings.frameIsMain) {
            let dataUri = scrapbook.stringToDataUri(data.content, data.mime, data.charset);
            return {timeId: timeId, sourceUrl: sourceUrl, url: dataUri};
          } else {
            var ext = "." + ((data.mime === "application/xhtml+xml") ? "xhtml" : "html");

            if (options["capture.saveInScrapbook"]) {
              var targetDir = options["capture.scrapbookFolder"] + "/data";
              var filename = timeId + ext;
              var savePrompt = false;
            } else {
              var targetDir = "";
              var filename = (data.title ? data.title : scrapbook.urlToFilename(sourceUrl));
              filename = scrapbook.validateFilename(filename, options["capture.saveAsciiFilename"]);
              if (!filename.endsWith(ext)) filename += ext;
              var savePrompt = true;
            }

            return capturer.saveBlob({
              timeId: timeId,
              blob: new Blob([data.content], {type: data.mime}),
              directory: targetDir,
              filename: filename,
              sourceUrl: sourceUrl,
              autoErase: false,
              savePrompt: savePrompt
            }).then((filename) => {
              return {timeId: timeId, sourceUrl: sourceUrl, targetDir: targetDir, filename: filename, url: scrapbook.escapeFilename(filename) + sourceUrlHash};
            });
          }
          break;
        }

        case "zip": {
          var ext = "." + ((data.mime === "application/xhtml+xml") ? "xhtml" : "html");
          var filename = documentName + ext;
          filename = scrapbook.validateFilename(filename, options["capture.saveAsciiFilename"]);

          if (!capturer.captureInfo.has(timeId)) { capturer.captureInfo.set(timeId, {}); }
          var zip = capturer.captureInfo.get(timeId).zip = capturer.captureInfo.get(timeId).zip || new JSZip();

          zip.file(filename, new Blob([data.content], {type: data.mime}), {
            compression: "DEFLATE",
            compressionOptions: {level: 9}
          });

          if (!settings.frameIsMain) {
            return {timeId: timeId, sourceUrl: sourceUrl, filename: filename, url: scrapbook.escapeFilename(filename) + sourceUrlHash};
          } else {
            // create index.html that redirects to index.xhtml
            if (ext === ".xhtml") {
              let html = '<meta charset="UTF-8"><meta http-equiv="refresh" content="0;url=index.xhtml">';
              zip.file("index.html", new Blob([html], {type: "text/html"}), {
                compression: "DEFLATE",
                compressionOptions: {level: 9}
              });
            }

            // generate and download the zip file
            return zip.generateAsync({type: "blob"}).then((zipBlob) => {
              if (options["capture.saveInScrapbook"]) {
                var targetDir = options["capture.scrapbookFolder"] + "/data";
                var filename = timeId + ".htz";
                var savePrompt = false;
              } else {
                var targetDir = "";
                var filename = (data.title ? data.title : scrapbook.urlToFilename(sourceUrl));
                filename = scrapbook.validateFilename(filename, options["capture.saveAsciiFilename"]);
                filename += ".htz";
                var savePrompt = true;
              }

              return capturer.saveBlob({
                timeId: timeId,
                blob: zipBlob,
                directory: targetDir,
                filename: filename,
                sourceUrl: sourceUrl,
                autoErase: false,
                savePrompt: savePrompt
              }).then((filename) => {
                return {timeId: timeId, sourceUrl: sourceUrl, targetDir: targetDir, filename: filename, url: scrapbook.escapeFilename(filename) + sourceUrlHash};
              });
            });
          }
          break;
        }

        case "maff": {
          var ext = "." + ((data.mime === "application/xhtml+xml") ? "xhtml" : "html");
          var filename = documentName + ext;
          filename = scrapbook.validateFilename(filename, options["capture.saveAsciiFilename"]);

          if (!capturer.captureInfo.has(timeId)) { capturer.captureInfo.set(timeId, {}); }
          var zip = capturer.captureInfo.get(timeId).zip = capturer.captureInfo.get(timeId).zip || new JSZip();

          zip.file(timeId + "/" + filename, new Blob([data.content], {type: data.mime}), {
            compression: "DEFLATE",
            compressionOptions: {level: 9}
          });

          if (!settings.frameIsMain) {
            return {timeId: timeId, sourceUrl: sourceUrl, filename: filename, url: scrapbook.escapeFilename(filename) + sourceUrlHash};
          } else {
            // create index.html that redirects to index.xhtml
            if (ext === ".xhtml") {
              let html = '<meta charset="UTF-8"><meta http-equiv="refresh" content="0;url=index.xhtml">';
              zip.file(timeId + "/" + "index.html", new Blob([html], {type: "text/html"}), {
                compression: "DEFLATE",
                compressionOptions: {level: 9}
              });
            }

            // generate index.rdf
            var rdfContent = `<?xml version="1.0"?>
<RDF:RDF xmlns:MAF="http://maf.mozdev.org/metadata/rdf#"
         xmlns:NC="http://home.netscape.com/NC-rdf#"
         xmlns:RDF="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <RDF:Description RDF:about="urn:root">
    <MAF:originalurl RDF:resource="${scrapbook.escapeHtml(sourceUrl)}"/>
    <MAF:title RDF:resource="${scrapbook.escapeHtml(data.title)}"/>
    <MAF:archivetime RDF:resource="${scrapbook.escapeHtml(scrapbook.idToDate(timeId).toUTCString())}"/>
    <MAF:indexfilename RDF:resource="${filename}"/>
    <MAF:charset RDF:resource="UTF-8"/>
  </RDF:Description>
</RDF:RDF>
`;

            zip.file(timeId + "/" + "index.rdf", new Blob([rdfContent], {type: "application/rdf+xml"}), {
              compression: "DEFLATE",
              compressionOptions: {level: 9}
            });

            // generate and download the zip file
            return zip.generateAsync({type: "blob"}).then((zipBlob) => {
              if (options["capture.saveInScrapbook"]) {
                var targetDir = options["capture.scrapbookFolder"] + "/data";
                var filename = timeId + ".maff";
                var savePrompt = false;
              } else {
                var targetDir = "";
                var filename = (data.title ? data.title : scrapbook.urlToFilename(sourceUrl));
                filename = scrapbook.validateFilename(filename, options["capture.saveAsciiFilename"]);
                filename += ".maff";
                var savePrompt = true;
              }

              return capturer.saveBlob({
                timeId: timeId,
                blob: zipBlob,
                directory: targetDir,
                filename: filename,
                sourceUrl: sourceUrl,
                autoErase: false,
                savePrompt: savePrompt
              }).then((filename) => {
                return {timeId: timeId, sourceUrl: sourceUrl, targetDir: targetDir, filename: filename, url: scrapbook.escapeFilename(filename) + sourceUrlHash};
              });
            });
          }
          break;
        }

        case "folder":
        default: {
          var targetDir = options["capture.scrapbookFolder"] + "/data/" + timeId;
          var ext = "." + ((data.mime === "application/xhtml+xml") ? "xhtml" : "html");
          var filename = documentName + ext;
          filename = scrapbook.validateFilename(filename, options["capture.saveAsciiFilename"]);

          return capturer.saveBlob({
            timeId: timeId,
            blob: new Blob([data.content], {type: data.mime}),
            directory: targetDir,
            filename: filename,
            sourceUrl: sourceUrl,
            autoErase: !settings.frameIsMain || (ext === ".xhtml"),
            savePrompt: false
          }).then((filename) => {
            if (settings.frameIsMain && (ext === ".xhtml")) {
              // create index.html that redirects to index.xhtml
              filename = "index.html";
              let html = '<meta charset="UTF-8"><meta http-equiv="refresh" content="0;url=index.xhtml">';
              return capturer.saveBlob({
                timeId: timeId,
                blob: new Blob([html], {type: "text/html"}),
                directory: targetDir,
                filename: filename,
                sourceUrl: sourceUrl,
                autoErase: false,
                savePrompt: false
              });
            }
            return filename;
          }).then((filename) => {
            return {timeId: timeId, sourceUrl: sourceUrl, targetDir: targetDir, filename: filename, url: scrapbook.escapeFilename(filename) + sourceUrlHash};
          });
          break;
        }
      }
    }).catch((ex) => {
      console.warn(scrapbook.lang("ErrorFileDownloadError", [sourceUrl, ex.message]));
      return {url: capturer.getErrorUrl(sourceUrl, options), error: ex};
    });
  });
};

/**
 * @kind invokable
 * @param {Object} params
 *     - {string} params.url
 *     - {string} params.refUrl
 *     - {string} params.rewriteMethod
 *     - {Object} params.settings
 *     - {Object} params.options
 * @return {Promise}
 */
capturer.downloadFile = function (params) {
  return Promise.resolve().then(() => {
    isDebug && console.debug("call: downloadFile", params);

    var {url: sourceUrl, refUrl, rewriteMethod, settings, options} = params,
        [sourceUrlMain] = scrapbook.splitUrlByAnchor(sourceUrl),
        {timeId} = settings;

    var headers = {};
    var filename;

    // init access check
    if (!capturer.captureInfo.has(timeId)) { capturer.captureInfo.set(timeId, {}); }
    var accessMap = capturer.captureInfo.get(timeId).accessMap = capturer.captureInfo.get(timeId).accessMap || new Map();

    // check for previous access
    var accessToken = capturer.getAccessToken(sourceUrlMain, rewriteMethod);
    var accessPrevious = accessMap.get(accessToken);
    if (accessPrevious) { return accessPrevious; }

    var accessCurrent = new Promise((resolve, reject) => {
      // special management of data URI
      if (sourceUrlMain.startsWith("data:")) {
        if (options["capture.saveDataUriAsFile"] && options["capture.saveAs"] !== "singleHtml") {
          let file = scrapbook.dataUriToFile(sourceUrlMain);
          if (file) {
            filename = file.name;
            filename = scrapbook.validateFilename(filename, options["capture.saveAsciiFilename"]);
            filename = capturer.getUniqueFilename(timeId, filename);

            resolve(Promise.resolve(capturer[rewriteMethod]).then((fn) => {
              if (fn) {
                return fn({
                  settings: settings,
                  options: options,
                  data: file,
                  charset: null,
                  url: null
                });
              }
              return file;
            }).then((blob) => {
              return capturer.downloadBlob({
                settings: settings,
                options: options,
                blob: blob,
                filename: filename,
                sourceUrl: sourceUrl,
              });
            }));
          } else {
            reject(new Error("Malformed data URL."));
          }
        } else {
          resolve({url: sourceUrl});
        }
        return;
      }

      let requestHeaders = {};
      if (refUrl) { requestHeaders["X-WebScrapBook-Referer"] = refUrl; }

      scrapbook.xhr({
        url: sourceUrl,
        responseType: "blob",
        requestHeaders: requestHeaders,
        onreadystatechange: function (xhr, xhrAbort) {
          if (xhr.readyState === 2) {
            // check for previous access if redirected
            let [responseUrlMain] = scrapbook.splitUrlByAnchor(xhr.responseURL);
            if (responseUrlMain !== sourceUrlMain) {
              var accessToken = capturer.getAccessToken(responseUrlMain, rewriteMethod);
              var accessPrevious = accessMap.get(accessToken);
              if (accessPrevious) {
                resolve(accessPrevious);
                xhrAbort();
                return;
              }
              accessMap.set(accessToken, accessCurrent);
            }

            // get headers
            if (xhr.status !== 0) {
              let headerContentDisposition = xhr.getResponseHeader("Content-Disposition");
              if (headerContentDisposition) {
                let contentDisposition = scrapbook.parseHeaderContentDisposition(headerContentDisposition);
                headers.isAttachment = (contentDisposition.type === "attachment");
                headers.filename = contentDisposition.parameters.filename;
              }
              let headerContentType = xhr.getResponseHeader("Content-Type");
              if (headerContentType) {
                let contentType = scrapbook.parseHeaderContentType(headerContentType);
                headers.contentType = contentType.type;
                headers.charset = contentType.parameters.charset;
              }
            }

            // determine the filename
            // use the filename if it has been defined by header Content-Disposition
            filename = headers.filename || scrapbook.urlToFilename(sourceUrl);

            // if no file extension, give one according to header Content-Type
            if (headers.contentType) {
              let [base, extension] = scrapbook.filenameParts(filename);
              if (!extension) {
                extension = Mime.prototype.extension(headers.contentType);
                if (extension) {
                  filename = base + "." + extension;
                }
              }
            }

            filename = scrapbook.validateFilename(filename, options["capture.saveAsciiFilename"]);
            // singleHtml mode always save as dataURI and does not need to uniquify
            if (options["capture.saveAs"] !== "singleHtml") {
              filename = capturer.getUniqueFilename(timeId, filename);
            }
          }
        },
        onload: function (xhr, xhrAbort) {
          resolve(Promise.resolve(capturer[rewriteMethod]).then((fn) => {
            if (fn) {
              return fn({
                settings: settings,
                options: options,
                data: xhr.response,
                charset: headers.charset,
                url: xhr.responseURL
              });
            }
            return xhr.response;
          }).then((blob) => {
            return capturer.downloadBlob({
              settings: settings,
              options: options,
              blob: blob,
              filename: filename,
              sourceUrl: sourceUrl,
            });
          }));
        },
        onerror: reject
      });
    }).catch((ex) => {
      console.warn(scrapbook.lang("ErrorFileDownloadError", [sourceUrl, ex.message]));
      return {url: capturer.getErrorUrl(sourceUrl, options), error: ex};
    });
    accessMap.set(accessToken, accessCurrent);
    return accessCurrent;
  });
};

/**
 * @kind invokable
 * @param {Object} params
 *     - {string} params.blob
 *     - {string} params.filename - validated and unique
 *     - {string} params.sourceUrl
 *     - {Object} params.settings
 *     - {Object} params.options
 * @return {Promise}
 */
capturer.downloadBlob = function (params) {
  return Promise.resolve().then(() => {
    isDebug && console.debug("call: downloadBlob", params);

    var {blob, filename, sourceUrl, settings, options} = params,
        [, sourceUrlHash] = scrapbook.splitUrlByAnchor(sourceUrl),
        {timeId} = settings;

    switch (options["capture.saveAs"]) {
      case "singleHtml": {
        return scrapbook.readFileAsDataURL(blob).then((dataUri) => {
          if (filename) {
            dataUri = dataUri.replace(";", ";filename=" + encodeURIComponent(filename) + ";");
          }
          return {url: dataUri + sourceUrlHash};
        });
      }

      case "zip": {
        if (!capturer.captureInfo.has(timeId)) { capturer.captureInfo.set(timeId, {}); }
        var zip = capturer.captureInfo.get(timeId).zip = capturer.captureInfo.get(timeId).zip || new JSZip();

        if (/^text\/|\b(?:xml|json|javascript)\b/.test(blob.type) && blob.size >= 128) {
          zip.file(filename, blob, {
            compression: "DEFLATE",
            compressionOptions: {level: 9}
          });
        } else {
          zip.file(filename, blob, {
            compression: "STORE"
          });
        }

        return {filename: filename, url: scrapbook.escapeFilename(filename) + sourceUrlHash};
      }

      case "maff": {
        if (!capturer.captureInfo.has(timeId)) { capturer.captureInfo.set(timeId, {}); }
        var zip = capturer.captureInfo.get(timeId).zip = capturer.captureInfo.get(timeId).zip || new JSZip();

        if (/^text\/|\b(?:xml|json|javascript)\b/.test(blob.type) && blob.size >= 128) {
          zip.file(timeId + "/" + filename, blob, {
            compression: "DEFLATE",
            compressionOptions: {level: 9}
          });
        } else {
          zip.file(timeId + "/" + filename, blob, {
            compression: "STORE"
          });
        }

        return {filename: filename, url: scrapbook.escapeFilename(filename) + sourceUrlHash};
      }

      case "folder":
      default: {
        // download the data
        var targetDir = options["capture.scrapbookFolder"] + "/data/" + timeId;

        return capturer.saveBlob({
          timeId: timeId,
          blob: blob,
          directory: targetDir,
          filename: filename,
          sourceUrl: sourceUrl,
          autoErase: true,
          savePrompt: false
        }).then((filename) => {
          return {timeId: timeId, sourceUrl: sourceUrl, targetDir: targetDir, filename: filename, url: scrapbook.escapeFilename(filename) + sourceUrlHash};
        });
      }
    }
  });
};

/**
 * @param {Object} params
 *     - {string} params.timeId
 *     - {string} params.blob
 *     - {string} params.directory
 *     - {string} params.filename
 *     - {string} params.sourceUrl
 *     - {boolean} params.autoErase
 *     - {boolean} params.savePrompt
 * @return {Promise}
 */
capturer.saveBlob = function (params) {
  return Promise.resolve().then(() => {
    isDebug && console.debug("call: saveBlob", params);

    var {timeId, blob, directory, filename, sourceUrl, autoErase, savePrompt} = params;

    return capturer.saveUrl({
      url: URL.createObjectURL(blob),
      directory: directory,
      filename: filename,
      sourceUrl: sourceUrl,
      autoErase: autoErase,
      savePrompt: savePrompt
    });
  });
};

/**
 * @param {Object} params
 *     - {string} params.timeId
 *     - {string} params.url
 *     - {string} params.directory
 *     - {string} params.filename
 *     - {string} params.sourceUrl
 *     - {boolean} params.autoErase
 *     - {boolean} params.savePrompt
 * @return {Promise}
 */
capturer.saveUrl = function (params) {
  return new Promise((resolve, reject) => {
    isDebug && console.debug("call: saveUrl", params);

    var {timeId, url, directory, filename, sourceUrl, autoErase, savePrompt} = params;

    var downloadParams = {
      url: url,
      filename: (directory ? directory + "/" : "") + filename,
      conflictAction: "uniquify",
      saveAs: savePrompt
    };

    isDebug && console.debug("download start", downloadParams);
    chrome.downloads.download(downloadParams, (downloadId) => {
      isDebug && console.debug("download response", downloadId);
      if (downloadId) {
        capturer.downloadInfo.set(downloadId, {
          timeId: timeId,
          src: sourceUrl,
          autoErase: autoErase,
          onComplete: resolve,
          onError: reject
        });
      } else {
        reject(chrome.runtime.lastError);
      }
    });
  });
};


/**
 * Events handling
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  isDebug && console.debug(message.cmd, "receive", "[" + (sender.tab ? sender.tab.id : -1) + "]", message.args);

  if (message.cmd.slice(0, 9) == "capturer.") {
    let fn = capturer[message.cmd.slice(9)];
    if (fn) {
      fn(message.args).then((response) => {
        sendResponse(response);
      });
      return true; // async response
    }
  }
});

chrome.downloads.onChanged.addListener((downloadDelta) => {
  isDebug && console.debug("downloads.onChanged", downloadDelta);

  var downloadId = downloadDelta.id, downloadInfo = capturer.downloadInfo;
  if (!downloadInfo.has(downloadId)) { return; }

  var p;
  if (downloadDelta.state && downloadDelta.state.current === "complete") {
    p = new Promise((resolve, reject) => {
      chrome.downloads.search({id: downloadId}, resolve);
    }).then((results) => {
      let [dir, filename] = scrapbook.filepathParts(results[0].filename);
      downloadInfo.get(downloadId).onComplete(filename);
    });
  } else if (downloadDelta.error) {
    p = Promise.resolve().then(() => {
      downloadInfo.get(downloadId).onError(new Error(downloadDelta.error.current));
    });
  }
  p && p.catch((ex) => {
    console.error(ex);
  }).then(() => {
    // erase the download history of additional downloads (autoErase = true)
    if (downloadInfo.get(downloadId).autoErase) {
      return new Promise((resolve, reject) => {
        chrome.downloads.erase({id: downloadId}, resolve);
      });
    }
  }).then((erasedIds) => {
    downloadInfo.delete(downloadId);
  }).catch((ex) => {
    console.error(ex);
  });
});

chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
  // Some headers (e.g. "referer") are not allowed to be set via
  // XMLHttpRequest.setRequestHeader directly.  Use a prefix and
  // modify it here to workaround.
  details.requestHeaders.forEach((header) => {
    if (header.name.slice(0, 15) === "X-WebScrapBook-") {
      header.name = header.name.slice(15);
    }
  });
  return {requestHeaders: details.requestHeaders};
}, {urls: ["<all_urls>"], types: ["xmlhttprequest"]}, ["blocking", "requestHeaders"]);

// isDebug && console.debug("loading background.js");
