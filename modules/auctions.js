module.exports = {
    processRequest, connect, checkAuctionList
}

var mongodb, acollection, ucollection, bot;
const AsyncLock = require('async-lock');
const dbManager = require('./dbmanager.js');
const reactions = require('./reactions');
const utils = require('./localutils');
const forge = require('./forge.js');
const heroes = require('./heroes.js');
const quests = require('./quest.js');
const settings = require('../settings/general.json');
const aucTime = 5;
const idlock = new AsyncLock();

function connect(db, client) {
    mongodb = db;
    bot = client;
    acollection = db.collection('auctions');
    ucollection = db.collection('users');
    tcollection = db.collection('transactions');
    setInterval(checkAuctionList, 5000);
}

function processRequest(user, args, channelID, callback) {
    let command = args.shift();
    switch(command) {
        case 'sell':
            sell(user, args, channelID, callback);
            break;
        case 'bid':
            bid(user, args, callback);
            break;
        case 'info':
            info(user, args, channelID, callback);
            break;
        default:
            if(command) args.unshift(command);
            list(user, args, channelID, callback);
            break;
    }
}

async function list(user, args, channelID, callback) {
    let match = {finished: false};
    let title = "Current auctions";
    let useDiff = false;

    args.map(a => {
        if(a[0] === '!' || a[0] === '-') {
            let el = a.substr(1);
            let m = a[0] === '!'? { $ne: user.id } : user.id;
            switch(el){
                case 'me':
                    match.author = m;
                    title = "Your auctions";
                    args = args.filter(arg => arg !== a);
                    break;
                case 'bid':
                    match.lastbidder = m;
                    title = "Your bids";
                    args = args.filter(arg => arg !== a);
                    break;
                case 'diff':
                    useDiff = true;
                    title = "Auctions with unique cards";
                    args = args.filter(arg => arg !== a);
                    break;
            }
        }
    });

    let auctionList = await acollection.aggregate([
            {"$match": match},
            {"$match": utils.getRequestFromFiltersWithPrefix(args, "card.")},
            {"$sort": {date: 1}},
            {"$limit": 200}
        ]).toArray();

    if(useDiff) {
        let userCards = await ucollection.findOne({discord_id: user.id}, {cards: 1});
        auctionList = auctionList.filter(a => userCards.cards.filter(c => utils.cardsMatch(a.card, c)) === 0);
    }

    let pages = getPages(auctionList, user.id);
    if(pages.length === 0) return callback(utils.formatError(user, null, 
        "no auctions with that request found"));

    reactions.addNewPagination(user.id, title, pages, channelID);
}

async function bid(user, args, callback) {
    if(!args || args.length < 2)
        return callback("**" + user.username + "**, please specify auction ID and bid amount");

    if(!utils.isInt(args[1]))
        return callback(utils.formatError(user, null, "price should be a number"));

    args[0] = args[0].replace(",", "");
    let price = parseInt(args[1]);
    let auc = await acollection.findOne({id: args[0]});
    if(!auc)
        return callback(utils.formatError(user, null, "auction `" + args[0] + "` not found"));

    if(auc.author === user.id) 
        return callback(utils.formatError(user, null, "you can't bid on your own auction"));

    if(auc.finished)
        return callback(utils.formatError(user, null, "auction `" + args[0] + "` already finished"));

    let aucPrice = getNextBid(auc);
    if(price <= aucPrice)  {
        let bidresp = "your bid for this auction should be more than **" + aucPrice + "**🍅";
        if(auc.hidebid) bidresp = "your bid is **too low!** Bid amount is hidden by hero effect.";
        return callback(utils.formatError(user, null, bidresp));
    }

    aucPrice = Math.floor(aucPrice * 1.5);
    if(price > aucPrice)  {
        let bidresp = "your bid for this auction can't be higher than **" + aucPrice + "**🍅";
        if(auc.hidebid) bidresp = "your bid is **too high**! Bid amount is hidden by hero effect.";
        return callback(utils.formatError(user, null, bidresp));
    }

    let dbUser = await ucollection.findOne({discord_id: user.id});
    if(!dbUser.hero)
        return callback(utils.formatError(user, null, "you have to have a hero in order to take part in auction"));

    if(dbUser.exp < price)
        return callback(utils.formatError(user, null, "you do not have enough tomatoes for that bid"));

    if(auc.lastbidder && auc.lastbidder === user.id) 
        return callback(utils.formatError(user, null, "you already bidded on that auction"));

    let hidebid = heroes.getHeroEffect(dbUser, 'auc', false);
    addExtraTime(auc);

    await ucollection.update({discord_id: user.id}, {$inc: {exp: -price}});
    if(auc.lastbidder) {
        await ucollection.update({discord_id: auc.lastbidder}, {$inc: {exp: auc.price}});
        auc.price = price;
        let strprice = hidebid? "???" : price;
        let msg = "Another player has outbid you on card **" + utils.getFullCard(auc.card)  + "** with a bid of **" + strprice + "**🍅\n";

        if(hidebid) msg += "Next required bid is hidden by hero effect.\n";
        else msg += "To remain in the auction, you should bid more than **" + getNextBid(auc) + "**🍅\n"
        msg += "Use `->auc bid " + auc.id + " [new bid]`\n";
        msg += "This auction will end in **" + getTime(auc) + "**";
        bot.sendMessage({to: auc.lastbidder, embed: utils.formatWarning(null, "Oh no!", msg)});
    } else {
        auc.price = price;
        let strprice = hidebid? "???" : price;
        let msg = "A player has bid on your card **" + utils.getFullCard(auc.card)  + "** with a bid of **" + strprice + "**🍅\n";

        if(hidebid) msg += "The bid is hidden by hero effect.\n";
        msg += "This auction will end in **" + getTime(auc) + "**";
        bot.sendMessage({to: auc.author, embed: utils.formatInfo(null, "Yay!", msg)});
    }

    await acollection.update({_id: auc._id}, {$set: {
        price: price, 
        lastbidder: user.id, 
        hidebid: hidebid, 
        timeshift: auc.timeshift,
        date: auc.date
    }});

    let p = utils.formatConfirm(user, "Bid placed", "you are now leading in auction for **" + utils.getFullCard(auc.card) + "**!");
    p.footer = {text: "Auction ID: " + auc.id}
    callback(p);

    quests.checkAuction(dbUser, "bid", callback);
}

function addExtraTime(auc) {
    if(!auc.timeshift) 
        auc.timeshift = 0;

    if(60*aucTime - utils.getMinutesDifference(auc.date) <= 5) {
        switch(auc.timeshift){
            case 0: auc.date.setMinutes(auc.date.getMinutes() + 5); break;
            case 1: auc.date.setMinutes(auc.date.getMinutes() + 2); break;
            default:
                auc.date.setMinutes(auc.date.getMinutes() + 1); break;
        }
        auc.timeshift++;
    }
    return auc;
}

async function sell(user, incArgs, channelID, callback) {
    let args = incArgs.join(' ').split(',');
    if(!args || args.length < 1) 
        return callback("**" + user.username + "**, please specify card query and price seperated by `,`\n"
            + "Or do not specify price to use eval");

    let query = utils.getRequestFromFilters(args[0].split(' '));
    dbManager.getUserCards(user.id, query).toArray((err, objs) => {
        if(!objs[0]) 
            return callback(utils.formatError(user, null, "no cards found that match your request"));

        let match = query['cards.name']? dbManager.getBestCardSorted(objs[0].cards, query['cards.name'])[0] : objs[0].cards[0];
        if(!match) return callback(utils.formatError(user, "Can't find card", "can't find card matching that request"));
        if (match.fav && match.amount == 1) 
            return callback(utils.formatError(user, null, "you can't sell favorite card."
                + " To remove from favorites use `->fav remove [card query]`"));

        dbManager.getCardValue(match, async (eval) => {
            let price;

            if(!args[1])
                price = Math.floor(eval);
            else if(!utils.isInt(args[1]))
                return callback(utils.formatError(user, null, "price should be a number"));
            else price = parseInt(args[1]);

            let min = Math.round(eval * .5);
            let dbUser = await ucollection.findOne({discord_id: user.id});
            let fee = Math.round(price * .1);

            if(!dbUser.hero)
                return callback(utils.formatError(user, null, "you have to have a hero in order to take part in auction"));

            if(price < min)
                return callback(utils.formatError(user, null, "you can't set price less than **" + min + "**🍅 for this card"));

            if(price > eval * 4)
                return callback(utils.formatError(user, null, "you can't set price more than **" + Math.round(eval * 4) + "**🍅 for this card"));

            if(dbUser.exp - fee < 0)
                return callback(utils.formatError(user, null, "you have to have at least **" + fee + "**🍅 to auction for that price"));

            reactions.addNewConfirmation(user.id, formatSell(user, match, price, fee), channelID, async () => {
                await idlock.acquire("createauction", async () => {
                    let aucID = await generateBetterID();
                    dbUser.cards = dbManager.removeCardFromUser(dbUser.cards, match);

                    if(!dbUser.cards || dbUser.cards.length == 0) return; 

                    await ucollection.update({discord_id: user.id}, {$set: {cards: dbUser.cards}, $inc: {exp: -fee}});
                    await acollection.insert({
                        id: aucID, finished: false, date: new Date(), price: price, author: user.id, card: match
                    });

                    callback(utils.formatConfirm(user, null, "you successfully put **" + utils.getFullCard(match) + "** on auction.\nYour auction ID `" + aucID + "`"));
                    quests.checkAuction(dbUser, "sell", callback);
                });
            });
        });
    });
}

function formatSell(user, card, price, fee) {
    let w = utils.formatWarning(user, null, "do you want to sell \n**" + utils.getFullCard(card) + "** on auction for **" + price + "**🍅?");
    w.footer = { text: "This will cost you " + fee + " tomatoes" }
    return w;
}

async function info(user, args, channelID, callback) {
    if(!args || args.length < 1)
        return callback("**" + user.username + "**, please specify auction ID");

    let auc = await acollection.findOne({id: args[0]});
    if(!auc)
        return callback(utils.formatError(user, null, "auction `" + args[0] + "` not found"));

    let author = await ucollection.findOne({discord_id: auc.author});
    if(auc.hidebid && user.id != auc.lastbidder) auc.price = "???";
    
    dbManager.getCardValue(auc.card, (eval) => {
        let resp = "";
        resp += "Seller: **" + author.username + "**\n";
        resp += "Last bid: **" + auc.price + "**`🍅`\n";
        resp += "Next minimum bid: **" + (auc.hidebid ? "???" : getNextBid(auc) + 1) + "**`🍅`\n"
        resp += "Card: **" + utils.getFullCard(auc.card) + "**\n";
        resp += "Card value: **" + Math.floor(eval) + "**`🍅`\n";
        resp += "[Card link](" + dbManager.getCardURL(auc.card) + ")\n";
        if(user.id == auc.lastbidder && !auc.finished) 
            resp += "You are currently leading in this auction\n";
        if(auc.finished) resp += "This auction finished**\n";
        else resp += "Finishes in: **" + getTime(auc) + "**\n";

        let emb = utils.formatInfo(null, "Information about auction", resp);
        emb.image = {url: dbManager.getCardURL(auc.card)};
        callback(emb);
    });
}

async function checkAuctionList() {
    let timeago = new Date();
    timeago.setHours(timeago.getHours() - aucTime);
    //timeago.setMinutes(timeago.getMinutes() - aucTime);

    let awaitauc = await acollection.aggregate([
        {"$match": {'finished': false, 'date' : {$lt: timeago}}},
        {"$sort": {date: 1}}, {'$limit': 1}
    ]).toArray();

    let auc = awaitauc[0];
    if(!auc) return;

    let dbuser = await ucollection.findOne({discord_id: auc.author});
    let transaction = {
        id: auc.id,
        price: auc.price,
        from: dbuser.username,
        from_id: dbuser.discord_id,
        status: "auction",
        time: new Date()
    }

    if(auc.lastbidder) {
        let bidder = await ucollection.findOne({discord_id: auc.lastbidder});
        bidder.cards = dbManager.addCardToUser(bidder.cards, auc.card);
        let tomatoback = Math.floor(forge.getCardEffect(bidder, 'auc', auc.price)[0]);
        await ucollection.update({discord_id: auc.lastbidder}, {$set: {cards: bidder.cards}, $inc: {exp: tomatoback}});
        await ucollection.update({discord_id: auc.author}, {$inc: {exp: auc.price}});

        transaction.to = bidder.username;
        transaction.to_id = bidder.discord_id;
        transaction.card = auc.card;
        await tcollection.insert(transaction);

        let yaaymes = "You won an auction for **" + utils.getFullCard(auc.card) + "**!\nCard is now yours.\n";
        if(tomatoback > 0) yaaymes += "You got **" + tomatoback + "** tomatoes back from that transaction.";
        bot.sendMessage({to: auc.lastbidder, embed: utils.formatConfirm(null, "Yaaay!", yaaymes)});
        bot.sendMessage({to: auc.author, embed: utils.formatConfirm(null, null, 
            "Your auction for card **" + utils.getFullCard(auc.card) + "** finished!\n"
            + "You got **" + auc.price + "**🍅 for it")});
    } else {
        dbuser.cards = dbManager.addCardToUser(dbuser.cards, auc.card);
        await ucollection.update({discord_id: auc.author}, {$set: {cards: dbuser.cards}});

        bot.sendMessage({to: auc.author, embed: utils.formatError(null, null, 
            "Your auction for card **" + utils.getFullCard(auc.card) + "** finished, but nobody bid on it.\n"
            + "You got your card back")});
    }

    await acollection.update({_id: auc._id}, {$set: {finished: true}});
}

function getPages(auc, userID) {
    let count = 0;
    let pages = [];
    auc.map(c => {
        if(count % 10 == 0)
            pages.push("");

        pages[Math.floor(count/10)] += auctionToString(c, userID);
        count++;
    });
    return pages.filter(item => item != "");
}

function auctionToString(auc, userID) {
    let resp = "";
    let hours = aucTime - utils.getHoursDifference(auc.date);

    if(hours < 0) return "";

    if(auc.hidebid) auc.price = "???";

    if(userID == auc.author) 
        if(auc.lastbidder == null) resp += "🔹";
        else resp += "🔷";
    else if(userID == auc.lastbidder) resp += "🔸";
    else resp += "▪";
    resp += "`[" + getTime(auc) + "] ";
    resp += "[" + auc.id + "] ";
    resp += "[" + getNextBid(auc) + "🍅]`  ";
    resp += "**" + utils.getFullCard(auc.card) + "**\n";
    return resp;
}

function getTime(auc) {
    let hours = aucTime - utils.getHoursDifference(auc.date);
    if (hours == 0)
        return "0s";
    if(hours <= 1){
        let mins = 60 - (utils.getMinutesDifference(auc.date) % 60);
        if(mins <= 1){
            let secs = 60 - (utils.getSecondsDifference(auc.date) % 60 % 60);
            if(secs <= 1)
                return "1s";
            return secs + "s";
        }
        return mins + "m";
    } else 
        return hours + "h";
}

async function generateBetterID() {
    let lastAuction = (await acollection.find({}).sort({$natural: -1}).limit(1).toArray())[0];
    return utils.generateNextId(lastAuction? lastAuction.id : "start");
}

function getNextBid(auc) {
    if(!utils.isInt(auc.price)) return "???";
    let newPrice = auc.price + auc.price * .02;
    let hours = aucTime - utils.getHoursDifference(auc.date);
    if(hours <= 1){
        let mins = 60 - (utils.getMinutesDifference(auc.date) % 60);
        newPrice += newPrice * (1/mins) * .2;
    }
    return Math.floor(newPrice);
    //return auc.price + 25;
}

