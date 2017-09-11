module.exports = {
    processRequest, connect,
    getCards, summon, transfer, sell, difference
}

var mongodb, ucollection;
const fs = require('fs');
const logger = require('./log.js');
const utils = require('./localutils.js');
const quest = require('./quest.js');
const heroes = require('./heroes.js');
const settings = require('../settings/general.json');
const listing = require('./reactions.js');
const forge = require('./forge.js');

function connect(db) {
    mongodb = db;
    ucollection = db.collection('users');
}

function processRequest(userID, args, callback) {
    ucollection.findOne({ discord_id: userID }).then((dbUser) => {
        if(!dbUser) return;

        var req = args.shift();
        switch(req) {
            case "list":
                getCards(dbUser, callback);
                break;
            case "sum":
            case "summon":
                summon(dbUser, args[0], args[1], callback);
                break;
            case "give":
            case "send":
                transfer(dbUser, args[0], args[1], callback);
                break;
            case "sell":
                sell(dbUser, args[0], callback);
                break;
            case "dif":
            case "diff":
            case "difference":
                difference(dbUser, args[0], args[1], args[2], callback);
                break;
        }
    }).catch(e => logger.error(e));
}

function getCards(dbUser, callback) {
	let cards = dbUser.cards;
	if(cards && cards.length > 0){
	    callback(cards);
	} else {
	    callback(null);
	}
}

function summon(dbUser, card, callback) {
    let check = card.toLowerCase().replace(/ /g, "_");
    if(!dbUser.cards){
        callback(dbUser.username + ", you have no any cards");
        return;
    }

    let match = getBestCardSorted(dbUser.cards, check)[0];
    if(match){
        let stat = dbUser.dailystats;
        let name = utils.toTitleCase(match.name.replace(/_/g, " "));
        let file = getCardFile(match);
        callback("**" + dbUser.username + "** summons **" + name + "!**", file);

        if(!stat) stat = {summon:0, send: 0, claim: 0, quests: 0};
        stat.summon++;

        heroes.addXP(dbUser, .1);
        ucollection.update(
            { discord_id: dbUser.discord_id }, {$set: {dailystats: stat}}
        ).then((e) => {
            quest.checkSummon(dbUser, (mes)=>{callback(mes)});
        });
    } else 
        callback("**" + dbUser.username + "** you have no card named **'" + card + "'**");
}

function transfer(dbUser, card, targetID, callback) {
    let check = card.toLowerCase().replace(/ /g, "_");
    let cards = dbUser.cards;
    if(!cards){
        callback(dbUser.username + ", you have no any cards");
        return;
    }

    if(dbUser.discord_id == targetID) {
        callback(dbUser.username + ", did you actually think it would work?");
        return;
    }

    let match = getBestCardSorted(dbUser.cards, check)[0];
    
    if(match){
        let name = utils.toTitleCase(match.name.replace(/_/g, " "));
        let hours = 12 - utils.getHoursDifference(match.frozen);
        if(hours && hours > 0) {
            callback("**" + dbUser.username + "**, the card **" 
                + name + "** is frozen for **" 
                + hours + "** more hours! You can't transfer it");
            return;
        }

        ucollection.findOne({ discord_id: targetID }).then(u2 => {
            if(!u2) return;

            let stat = dbUser.dailystats;
            let i = cards.indexOf(match);
            cards.splice(i, 1);

            if(!stat) stat = {summon: 0, send: 0, claim: 0};
            stat.send++;

            var fromExp = dbUser.exp;
            fromExp = heroes.getHeroEffect(dbUser, 'send', fromExp, match.level);
            if(fromExp > dbUser.exp) 
                callback("**Akari** grants **" + Math.round(fromExp - dbUser.exp) 
                    + "** tomatoes targetID **" + dbUser.username 
                    + "** for sending a card!");

            heroes.addXP(dbUser, .3);
            ucollection.update(
                { discord_id: dbUser.discord_id }, 
                { $set: {cards: cards, dailystats: stat, exp: fromExp}}
            ).then(() => {
                quest.checkSend(dbUser, match.level, (mes)=>{callback(mes)});
            });

            match.frozen = new Date();
            ucollection.update(
                { discord_id: targetID },
                { $push: {cards: match }}
            ).then(() => {
                forge.getCardEffect(dbUser, 'send', u2, callback);
            });

            callback("**" + dbUser.username + "** sent **" + name + "** targetID **" + u2.username + "**");
        });
        return;
    }
    callback("**" + dbUser.username + "** you have no card named **'" + card + "'**");
}

function sell(dbUser, card, callback) {
    let check = card.toLowerCase().replace(/ /g, "_");
    let cards = dbUser.cards;
    if(!cards){
        callback(dbUser.username + ", you have no any cards");
        return;
    }

    let match = getBestCardSorted(dbUser.cards, check)[0];
    if(match) {
        heroes.addXP(dbUser, .1);
        let exp = forge.getCardEffect(dbUser, 'sell', settings.cardprice[match.level - 1])[0];
        cards.splice(cards.indexOf(match), 1);
        ucollection.update(
            { discord_id: dbUser.discord_id },
            {
                $set: {cards: cards },
                $inc: {exp: exp}
            }
        );

        let name = utils.toTitleCase(match.name.replace(/_/g, " "));
        callback("**" + dbUser.username + "** sold **" + name + "** for **" + exp + "** 🍅 Tomatoes");
    } else
        callback("**" + dbUser.username + "**, you have no card named **'" + card + "'**");
}

function difference(dbUser, discUser, targetID, args, callback) {
    if(dbUser.discord_id == targetID) {
        callback("Eh? That won't work");
        return;
    }

    ucollection.findOne({ discord_id: targetID }).then((user2) => {
        if(!user2) return;

        let dif = user2.cards.filter(x => user.cards.filter(y => x.name == y.name) == 0);
        let cards = [];
        dif.forEach(element => { cards.push(element) }, this);
        
        if(cards.length > 0) 
            callback(listing.addNew(discUser, args, cards, user2.username));
        else
            callback("**" + user2.username + "** has no any unique cards for you\n");
    });
}

