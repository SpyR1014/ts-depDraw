/**
 * Author: Andrew Jakubowicz
 *
 * My first attempt to put together a nodejs server.
 *
 *
 *
 * API:
 *
 * /api/getFileText
 *  - returns plain text of the file.
 *  - default: returns text from initiated file.
 *
 * 
 * /api/getTokenType (filePath, line, offset)
 *  - returns data for the type of token requested.
 * 
 * 
 * /api/getTokenDependencies (filePath, line, offset)
 *  - returns the dependencies.
 * 
 * 
 * /api/getTokenDependents (filePath, line, offset)
 *  - returns the dependents.
 * 
 */

import * as http from 'http';
import * as express from 'express';
import * as fs from 'fs';
import * as path from 'path';

import * as winston from "./appLogger";
import * as tss from "./tsserverWrap";
import * as jsonUtil from './util/jsonUtil';



// Server creation
let server = express();
let tssServer = new tss.TsserverWrapper();

// Check globals
global.tsconfigRootDir = global.tsconfigRootDir || (() => {throw new Error('tsconfigRootDir not set')})();
global.rootFile = global.rootFile || (() => {throw new Error('rootFile not set')})();


// languageHost.getEncodedSemanticClassifications()


// Loads the project into tsserver.
setTimeout(() => {
    tssServer.open(global.rootFile)
        .then(() => { winston.log('trace', `Opened file:`, global.rootFile); })
        .catch(err => { throw err });
}, 1);

// This sets up a virtual path from '/' to the static directory. Adapted from
// https://expressjs.com/en/starter/static-files.html If this middleware fails,
// it will fall through to the next handler. We don't know where our app will be
// located. Hence the path.join
server.use('/', express.static(path.join(__dirname, '..', 'static')));

// This should allow CORS on the server.
// Thank you: http://enable-cors.org/server_expressjs.html
server.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});


/**
 * Loads in plain text of the file.
 * 
 *  If there is no filePath sent then it opens the initiated file.
 */
server.get('/api/getFileText', (req : express.Request, res : express.Response) => {
    winston.log('data', `Query for getFileText from url: ${req.url}`);

    let filePath : string;

    /** If filePath exists then lookup that files text. */
    if (req.query.hasOwnProperty('filePath')) {
        filePath = req.query["filePath"]
    } else {
        filePath = global.rootFile;
    }

    // Initiate tssServer open callback.
    tssServer.open(filePath)
        .then( response => { winston.log('trace', 'promise fulfilled:', response)})
        .catch(err => { throw err });

    // Grab file text
    fs.readFile(filePath, 'utf8', function (err, data) {
            if (err) {
                winston.log('error', `getFileText failed with ${err}`);
                return res.status(500)
                          .send('Unable to get root file text!');
            }

            let fileTextResponse = {
                file: filePath,
                text: data
            }

            return res.status(200)
                      .send(JSON.stringify(fileTextResponse));
        });

});


/**
 * getTokenType returns the type of a specific token.
 * 
 * Requires filePath {string}, line {number}, offset {number}.
 */
server.get('/api/getTokenType', (req: express.Request, res: express.Response) => {
    winston.log('info', `Query for getTokenType:`, req.query);
    
    if (sanitiseFileLineOffset(req, res) !== true){
        return
    }

    let filePath = req.query['filePath'],
        line = parseInt(req.query['line']),
        offset = parseInt(req.query['offset']);
    
    tssServer.open(filePath)
        .then( _ => { winston.log('trace', `opened ${filePath}`)});

    tssServer.quickinfo(filePath, line, offset)
        .then(response => {
            winston.log('trace', `Response of type`, response);
            res.setHeader('Content-Type', 'application/json');
            return res.status(200).send(JSON.stringify(response));
        })
        .catch(err => {
            winston.log('error', 'error in quickinfo in server', err);
        });
});


/**
 * getTokenDependencies returns the dependencies of a specified token.
 * 
 * Finds definition of token, and then filters the tokens from the definition filePath
 * to only include the tokens which are Indentifiers and within the start and end range.
 * 
 * QuickInfo is then called on the dependencies found to get their info and an array is sent.
 */
server.get('/api/getTokenDependencies', (req: express.Request, res: express.Response) => {
    winston.log('info', `Query for getTokenDependencies:`, req.query);

    let errFunc = (err: Error) => {
        winston.log('error', `Error occurred in getTokenDependencies`, err);
        if (!res.finished){
            return res.status(500).send('Internal Server Error');
        }
        return
    }

    if (sanitiseFileLineOffset(req, res) !== true){
        return
    }
    let filePath = req.query['filePath'],
        line = parseInt(req.query['line']),
        offset = parseInt(req.query['offset']);

    tssServer.open(filePath)
        .catch(err => {
            winston.log('error', `Couldn't open file`, err);
            return res.status(500).send('Internal error');
        });

    let definitionToken;
    let definitionFilePath: string;

    tssServer.definition(filePath, line, offset)
    .then((response: string) => {
        if (!response.success){
            res.status(204).send(JSON.stringify(response));
            throw new Error('success false');
        }
        return response;
    }, errFunc)
    .then(resp => {

        definitionToken = resp;
        definitionFilePath = resp.body[0].file

        return tss.scanFileForIdentifierTokens(path.relative(global.tsconfigRootDir, definitionFilePath));
    }).then(allFileTokens => {
        let tokenDefinition = definitionToken
        winston.log('trace', `Slicing dependencies using`, definitionToken, allFileTokens);

        return extractTokensFromFile(allFileTokens,
                                        tokenDefinition.body[0].start,
                                        tokenDefinition.body[0].end);
        
    }, err => {
        winston.log('error', `Error selectedDependencies`, err);
        throw err;
    })
    .then(selectTokens => {
        // This is where we filter by token type.
        return selectTokens.filter( token => token.type === 'Identifier' );
    }).then(selectedTokens => {
        // Here we are adding metadata.
        let quickInfoList = [];
        (selectedTokens as any[]).forEach(token => {
            quickInfoList.push(tssServer.quickinfo(definitionFilePath, token.start.line, token.start.character));
        });
        return Promise.all(quickInfoList);
    }).then(args => {
        const trimmedArgs = args.map(v => v.body);
        trimmedArgs.forEach(v => { v['file'] = definitionFilePath });
        return trimmedArgs;
    }).then(args => {
        res.setHeader('Content-Type', 'application/json');
        // Remove the first token, as it *most likely* the definition token.
        return res.status(200).send(JSON.stringify(args.slice(1)));
    })
    .catch(errFunc)
});

/**
 * getTokenDependents returns the dependents of a specified token.
 * 
 */
server.get('/api/getTokenDependents', (req: express.Request, res: express.Response) => {
    winston.log('info', `Query for getTokenDependents:`, req.query);

    let errFunc = (err) => {
        winston.log('trace', `Error occurred in getTokenDependents`, err);
        if (!res.finished){
            return res.status(500).send('Internal Server Error');
        }
        
    }

    if (sanitiseFileLineOffset(req, res) !== true){
        return
    }
    let filePath = req.query['filePath'],
        line = parseInt(req.query['line']),
        offset = parseInt(req.query['offset']);
    
    tssServer.open(filePath)
        .then( _ => { winston.log('trace', 'opened:', filePath)})
        .catch(errFunc);

    winston.log('trace', 'open, now references');
    
    tssServer.references(filePath, line, offset)
        .then(responseObject => {
            if (!(responseObject as any).success){
                res.status(204).send();
                throw new Error('references success false');
            }
            return responseObject
        })
        .then(referenceObject => {
            winston.log('trace', `referenceObject: `, referenceObject);
            let references = referenceObject.body.refs;
            return (references as any[]).filter( refToken => !refToken.isDefinition );
        })
        .then(filteredList => {
            // Here we need to collect a list of unique file paths.
            winston.log('trace', `filtered referenceObject: `, filteredList);
            let filePaths: Set<string> = new Set(); // Sets are iterated over in insertion order.
            let relativePath: string;

            (filteredList as any[]).forEach(token => {
                relativePath = path.relative(global.tsconfigRootDir, token.file);
                filePaths.has(relativePath) || filePaths.add(relativePath);
            });

            let navtreePromises = [];
            filePaths.forEach(relativeFilePath => {
                tssServer.open(relativeFilePath)
                    .catch(errFunc)
                
                navtreePromises.push(tssServer.navtree(relativeFilePath))
            });

            // This promise is all the unique navtrees.
            return Promise.all([...navtreePromises, filteredList]);
        }).then(navTreeResponse => {
            winston.log('trace', `Response to navtree:`, navTreeResponse);
            let references = (navTreeResponse as any[]).slice(-1)[0];
            let navTrees = navTreeResponse.slice(0, -1);

            let scopesAffectedByReference = [];
            winston.log('trace', `reflength and navTrees length`, references.length, navTrees.length);
            references.forEach((tokenRef, i) => {
                winston.log('trace', `Dispatching traverseNavTreeToken on `, navTrees[i].body, `and token reference`, tokenRef);
                let _tempDependents = traverseNavTreeToken(navTrees[i].body, tokenRef);
                winston.log('trace', '_tempDependents:', _tempDependents, 'for token:', tokenRef);
                scopesAffectedByReference.push(..._tempDependents);
            });
            winston.log('trace', `scopesAffectedByReference after forEach:`, scopesAffectedByReference)
            return scopesAffectedByReference
        }).then(scopesAffectedByReference => {

            // Find the reference identifier.
            const newTokens = (scopesAffectedByReference as any).map(token => {
                // Huge overhead here, find first identifier token of the scope given.
                // We need to add exceptions (like modules, and maybe more?...)
                return tss.scanFileForIdentifierTokens(token.file)
                    .then(allFileTokens => {
                        const filteredTokens = extractTokensFromFile(allFileTokens, token.spans.start, token.spans.end)
                        for (let _token of filteredTokens){
                            if (_token.type === 'Identifier') {
                                return tssServer.quickinfo(token.file, _token.start.line, _token.start.character)
                                    .then(quickInfoResponse => {
                                        let responseObj = quickInfoResponse.body;
                                        responseObj.file = token.file;
                                        switch (token.kind){
                                            case 'module':
                                                responseObj.kind = token.kind;
                                                responseObj.displayString = token.text;
                                        }
                                        return responseObj
                                    });
                            }
                        }
                    })
            })
            return Promise.all(newTokens);
        })
        .then(scopesAffected => {
            res.setHeader('Content-Type', 'application/json');
            return res.status(200).send(JSON.stringify(scopesAffected));
        })
        .catch(errFunc);
});

/**
 * Helper function for making sure that query contains filePath, line and offset properties.
 */
function sanitiseFileLineOffset(req: express.Request, res: express.Response){
    if (!(req.query.hasOwnProperty('filePath') && req.query.hasOwnProperty('line') && req.query.hasOwnProperty('offset'))) {
        winston.log('error', `need filePath && line && offset given in request`, req.query);

        return res.status(400).send('Malformed client input.');
    }

    if (isNaN(parseInt(req.query['line'])) || isNaN(parseInt(req.query['offset']))){
        winston.log('error', `Line and offset must be numbers!`);
        return res.status(400).send('Malformed client input.');
    }
    return true;
}

/**
 * Helper function that ~~binary~~ searches a file list.
 */
function extractTokensFromFile(fileTokenList, start, end){
    winston.log('trace', `extractTokensFromFile called with`, arguments);


    // TODO: optimise with binary search.
    return fileTokenList.filter(token => {
        if (token.start.line === start.line) {
            return token.start.character > start.offset
        }
        if (token.start.line === end.line) {
            return token.start.character < end.offset
        }
        return (token.start.line >= start.line && token.start.line <= end.line)
    });
}

/**
 * Helper function for traversing the navTree
 */
function traverseNavTreeToken(navTreeToken, refToken, results = []): any[]{
    if (!tokenInRange(navTreeToken.spans[0].start,navTreeToken.spans[0].end, refToken.start)){
        winston.log('trace', `inside tokenInRange, returning empty`);
        return []
    }
    let leafToken = {text: navTreeToken.text,
                    kind: navTreeToken.kind,
                    kindModifiers: navTreeToken.kindModifiers,
                    spans: navTreeToken.spans,
                    file: path.relative(global.tsconfigRootDir ,refToken.file)
                }

    if (leafToken.spans.length !== 1){
        winston.log('warn', 'Spans is not == 1, Info lost!', leafToken);
    }
    leafToken.spans = leafToken.spans[0];
    winston.log('trace', `Created childItemScope: `, leafToken, results);
    if (!navTreeToken.childItems){
        return [leafToken];
    } else {
        results.push(leafToken);
    }
    navTreeToken.childItems.forEach(token => {
        results.push(...traverseNavTreeToken(token, refToken, []))
    });
    winston.log('trace', `Results array: `, results);
    return results
}

/**
 * tokenInRange returns boolean representing if token is within scope.
 * TODO: refine this filter.
 */
function tokenInRange(start, end, tokenStart){
    winston.log('trace', `tokenInRange`, start.line <= tokenStart && end.line >= tokenStart)
    return start.line <= tokenStart.line && end.line >= tokenStart.line
}



export let SERVER = server;