const Telegraf = require('telegraf')
const Extra = require('telegraf/extra')
const Markup = require('telegraf/markup')
const session = require('telegraf/session')
const request = require("request");
var fs = require('fs');
const { reply, fork } = Telegraf

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
console.log("Bot configuration is set to:\n" + JSON.stringify(bot_config, null, 4));

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
bot.start((ctx) => ctx.reply(
    bot_config["start_message"] + "\n" + "A keyboard with available commands has been enabled",
    Markup.keyboard(keys)
    .oneTime()
    .resize()
    .extra()
));

console.log(keys);

//TODO fill the help with the list of commands and its description
help = bot_config["help_message"]
commands_help = ""
if(help) commands_help = help + "\n\n";
commands_help += "Commands:\n"

bot_config["requests"].forEach(req => {
    commands_help+="/" + req.command+" "+req.help+ "\n";
});
commands_help += "/help Show this help message.\n";


bot.help((ctx) => ctx.reply(commands_help, 
    Markup.keyboard(keys)
    .oneTime()
    .resize()
    .extra()
    )
);

// iterate over requests definition
bot_config["requests"].forEach(req => {
    function action(ctx) {
        request(req.options, (error, response, body) => {
            if (error) {
                console.log(error)
                ctx.reply(error)
            } else {
                ctx.reply(body)
            }
        });
    }
    bot.command(req.command, action);
});

bot.catch(function (err) {
    console.log(err);
});

// Launch bot
console.log("Connecting to Telegram...")

bot.launch().then(()=>{
    console.log("Connected.")
})


