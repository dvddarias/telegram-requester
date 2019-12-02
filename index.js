const Telegraf = require('telegraf')
const Extra = require('telegraf/extra')
const Markup = require('telegraf/markup')
const session = require('telegraf/session')
const request = require("request");
const Mustache = require("mustache");
var fs = require('fs');

// check and load configuration
if (!process.env.CONFIG){
    process.env.CONFIG = "./config.json"
}
try {
    var data = fs.readFileSync(process.env.CONFIG, 'utf8');
} catch (error) {
    console.log("Failed reading bot configuration at: " + process.env.CONFIG);
    process.exit(1);
}
// validate the config matches the bot configuration json schema
bot_config = JSON.parse(data);
// console.log("Bot configuration is set to:\n" + JSON.stringify(bot_config, null, 4));

//if env variable is set, override config settings
if (process.env.BOT_TOKEN) bot_config["bot_token"] = process.env.BOT_TOKEN
// create the bot
const bot = new Telegraf(bot_config["bot_token"])

//this is to capture signals and avoid hanging on docker sigterm   
function exitOnSignal(signal) {
    process.on(signal, function () {
        console.log('Caught ' + signal + ', exiting...');
        bot.stop().then(() => {
            console.log("Bye!")
            process.exit();
        })
    });
}
exitOnSignal('SIGINT');
exitOnSignal('SIGTERM');


var keys = ["/help"];
bot_config["requests"].forEach(req => {
    keys.push("/" + req.command);
});

//setup start and help response
bot.start((ctx) =>{
    if (allowed(ctx)){
        ctx.reply(
            bot_config["start_message"] + "\n" + "A keyboard with available commands has been enabled",
            Markup.keyboard(keys)
            .oneTime()
            .resize()
            .extra()
        )
    }    
});

//if it is a channel respond to /id command with the channel info
//this is ised to fill the channels list used to broadcast the results
bot.use((ctx, next)=>{
    var post = ctx.update.channel_post;
    if(!post || post.text!="/id") return next()
    var message = "<i>" + post.chat.title + "</i> channel info:";
    message += "\n<b>id:</b> " + post.chat.id
    message += "\n<b>type:</b> " + (post.chat.username?"public":"private")
    if (post.chat.username) message += "\n<b>name:</b> " + "@" + post.chat.username
    ctx.reply(message, Extra.HTML())
    return next()
})

//control usage access to commands
bot.use((ctx, next) => {
    if(allowed(ctx)) next();
})

function allowed(ctx){
    if (ctx.update && ctx.update.message && ctx.update.message.from) {
        const user = ctx.update.message.from
        const access = bot_config["access"]
        if (access && access.includes(user.id+"")) return true;
        else {
            message = "You are not allowed to run any request using this bot.\nContact the bot manager and ask him to include you using the id: " + user.id
            ctx.reply(message, Extra.HTML())            
        }
    }
    return false;

}

//Fill the help with the list of commands and its description
help = bot_config["help_message"]
commands_help = ""
if (help) commands_help = help + "\n\n";
commands_help += "Commands:\n"

bot_config["requests"].forEach(req => {
    commands_help += "/" + req.command + " " + req.help + "\n";
});
commands_help += "/help Show this help message.\n";


bot.help((ctx) => ctx.reply(commands_help,
    Markup.keyboard(keys)
    .oneTime()
    .resize()
    .extra()
));

// iterate over requests definition
const regex = /^\/([^@\s]+)@?(?:(\S+)|)\s?([\s\S]+)?$/i;
bot_config["requests"].forEach(req => {

    function action(ctx, next) {
        const view = {}
        console.log("/"+req.command + " requested.")
        //find the parameters in the command and fill the view object
        if(req.params && req.params.inline){
            const inline = req.params.inline;
            console.log("Parameters: " + ctx.message.text.trim())
            const parts = regex.exec(ctx.message.text.trim());
            if(parts){
                const args = !parts[3] ? [] : parts[3].split(/\s+/).filter(arg => arg.length);
                if(args){
                    if(args.length<inline.length){
                        error = "/" + req.command + " requires <b>" + inline.length + "</b> positional argument" + (inline.length > 1 ? "s:" : ":")
                        help = ""
                        for (let i = 0; i < inline.length; i++) {
                            const param = inline[i];
                            help+= "\n<b>" + param.name + "</b>: "+param.help
                        }
                        ctx.reply(error+help, Extra.HTML())
                        return next()
                    }
                    else{
                        for (let i = 0; i < inline.length; i++) {
                            const param = inline[i];
                            view[param.name] = args[i]
                        }
                    }
                }
            }
        }
        
        //replace the values of the view object on the options of the request
        const replaced = Mustache.render(JSON.stringify(req.options), view);

        // DEBUG TEMPLATING
        // console.log(view)
        // console.log(JSON.stringify(req.options))
        // console.log(replaced)

        request(JSON.parse(replaced), (error, response, body) => { 
            if(error){
                console.log("There was an error on the request triggered by: "+req.command)
                console.log(error)
                console.log("Options:\n" + JSON.stringify(req.options))
            }  
            else{
                message = getMessageContent(req, ctx, response, body, view, false);
                if (message != null && message != "") ctx.reply(message, Extra.HTML())
                broadcastRequest(req, ctx, response, body, view);
            }                     
            return next()
        });
    }

    bot.command(req.command, action);
});

function broadcastRequest(req, ctx, response, body, view){
    if (!bot_config["channels"] || bot_config["channels"].length==0) return;
    
    message = getMessageContent(req, ctx, response, body, view, true);
    if (message == null || message=="") return;

    bot_config["channels"].forEach(channelId => {
        bot.telegram.sendMessage(channelId, message, Extra.HTML())
    });
}

function getMessageContent(req, ctx, response, body, view, is_broadcast){
    content = is_broadcast?req.broadcast:req.response;    
    message = ""
    if(!content) return message;
    if(is_broadcast){
        message += "📢 <b>/" + req.command + "</b> was called";
        if (content.includes("username")) message += " by <b>" + getUserName(ctx) + "</b>"
        message += ".\n"
    }    
    if (content.includes("params")) message += getParamList(view)
    if (content.includes("http_code")) message += getHttpCodeMessage(response)
    if (content.includes("headers")) message += getHttpHeaders(response)
    if (content.includes("body")) message += "📦 Response:\n" + body + "\n"

    return message
}

function getParamList(view) {
    message = "";
    for (const param in view) {
        if (view.hasOwnProperty(param)) {
            const value = view[param];
            message += "🏷 <b>" + param + "</b>: " + value + "\n"
        }
    }
    return message;
}

function getHttpHeaders(response) {
    message="";
    for (const header in response.headers) {
        if (response.headers.hasOwnProperty(header)) {
            const val = response.headers[header];
            message += "📋 <i>" + header + "</i>: " + val + "\n"
        }
    }    
    return message;
}

function getHttpCodeMessage(response) {
    var code = response.statusCode;
    var emoji = "";
    if (code >= 500) emoji = "⛔️ "
    else if (code >= 400) emoji = "⚠️ "
    else if (code >= 300) emoji = "🔀 "
    else if (code >= 200) emoji = "✅ "
    else if (code >= 100) emoji = "ℹ️ "
    return  emoji + code + " " + response.statusMessage+"\n";
}

function getUserName(ctx){
    var from = ctx.update.message.from;
    if (from.first_name) return from.first_name+" "+from.last_name
    else return "@"+from.username
}

bot.catch(function (err) {
    console.log(err);
});

// Launch bot
console.log("Connecting to Telegram...")

bot.launch().then(()=>{
    console.log("Connected.")
})


