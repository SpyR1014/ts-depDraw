/**
 * Author: Andrew Jakubowicz
 * 
 * My first attempt to put together a nodejs server.
 * 
 */

import * as http from 'http';
import * as express from 'express';
import * as fs from 'fs';

import * as winston from "./appLogger";

let config = require("../config.json");

// Port defined
// TODO: add to config.
const PORT = 8080;

// Server creation
let server = express();

// This sets up a virtual path from '/' to the static directory.
// Adapted from https://expressjs.com/en/starter/static-files.html
// If this middleware fails, it will fall through to the next handler.
server.use('/', express.static('static'));

/**
 * This is the api used to load the code files into the browser.
 * 
 * Default:
 *  If there is no fileName supplied, the api responds with the config.rootFile
 *  filePath.
 */
server.get('/api/getFileText', (req: express.Request, res: express.Response) => {
    winston.log('data', `Query for getFileText from url: ${req.url}`);

    if (req.query.hasOwnProperty('filePath')){
        // Fulfill query providing text for the requested file.
        let fileTextResponse = {
            file: req.query["filePath"],
            text: "Example Text so far!"
        }
        res.status(200).send(JSON.stringify(fileTextResponse));
    } else {
        // Optimistically assume they want root text.
        fs.readFile(config.rootFile, 'utf8', function(err, data){
            if (err) {
                winston.log('error', `Default getFileText failed with ${err}`);
                res.status(500).send('Unable to get root file text!');
            }
            let fileTextResponse = {
                file: config.rootFile,
                text: data
            }
            res.status(200).send(JSON.stringify(fileTextResponse));
        });

        
    }
});

server.listen(PORT, (err) => {
    if (err) {
        return console.log(`Error starting server: ${err}`);
    }
    console.log(`Server started and listening on port: ${PORT}`);
});