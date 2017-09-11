module.exports = {
    processRequest, connect
}

var mongodb, ucollection;
const fs = require('fs');
const logger = require('./log.js');
const utils = require('./localutils.js');
const cards = require('./cards.js');

function connect(db) {
    mongodb = db;
    ucollection = db.collection('users');
}

function processRequest(userID, args, callback) {
    var req = args.shift();
    switch(req) {
        case "cards":
            cards.getCards(userID, callback);
            break;
        case "sum":
        case "summon":
            cards.summon(userID, args, callback);
            break;
        case "give":
        case "send":
            cards.transfer(userID, args, callback);
            break;
        case "sell":
            cards.sell(userID, args, callback);
            break;
        case "dif":
        case "diff":
        case "difference":
            cards.difference(userID, args, callback);
            break;
    }
}