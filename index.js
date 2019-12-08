const Telegraf = require('telegraf')
const Extra = require('telegraf/extra')
const Markup = require('telegraf/markup')
const session = require('telegraf/session')
const request = require("request");
const Mustache = require("mustache");
const uuidv1 = require('uuid/v1');
const fs = require('fs');

// check and load configuration
if (!process.env.CONFIG){
    process.env.CONFIG = "./config.json"
}
try {
    var data = fs.readFileSync(process.env.CONFIG, 'utf8');
} catch (error) {
    console.log(`Failed reading bot configuration at: ${process.env.CONFIG}`);
    process.exit(1);
}
// TODO validate the config matches the bot configuration json schema
bot_config = JSON.parse(data);
// console.log("Bot configuration is set to:\n" + JSON.stringify(bot_config, null, 4));

//if env variable is set, override config settings
if (process.env.BOT_TOKEN) bot_config["bot_token"] = process.env.BOT_TOKEN
// create the bot
const bot = new Telegraf(bot_config["bot_token"])

//this is to capture signals and avoid hanging on docker sigterm   
function exitOnSignal(signal) {
    process.on(signal, function () {
        console.log(`Caught ${signal}, exiting...`);
        bot.stop().then(() => {
            console.log("Bye!")
            process.exit();
        })
    });
}
exitOnSignal('SIGINT');
exitOnSignal('SIGTERM');

//create a keyboard with all the commands in the configuration + /help command
var keys = ["/help"];
bot_config["requests"].forEach(req => {
    keys.push("/" + req.command);
});

//in start (if allowed) activate the command keyboard.
bot.start((ctx) =>{
    if (allowed(ctx)){
        ctx.reply(
            `${bot_config["start_message"]}\nA keyboard with available commands has been enabled`,
            Markup.keyboard(keys)
            .oneTime()
            .resize()
            .extra()
        )
    }    
});

//if it is a channel respond to /id command with the channel info
//this is used to fill the channels list used to broadcast the results
bot.use((ctx, next)=>{
    var post = ctx.update.channel_post;
    if(!post || post.text!="/id") return next()
    var message = `<i>${post.chat.title}</i> channel info:`;
    message += `\n<b>id:</b> ${post.chat.id}`
    message += `\n<b>type:</b> ${(post.chat.username?"public":"private")}`
    if (post.chat.username) message += `\n<b>name:</b> @${post.chat.username}`
    ctx.reply(message, Extra.HTML())
    return
})

//this is the session object, it is unique per chat.id and from.id
bot.use(session({
    getSessionKey: (ctx) => {
        if (ctx.from && ctx.chat) {
            return `${ctx.from.id}:${ctx.chat.id}`
        } else if (ctx.from && ctx.inlineQuery) {
            return `${ctx.from.id}:${ctx.from.id}`
        }
        return null
    }
}))

//control usage access to commands
bot.use((ctx, next) => {
    if(allowed(ctx)) return next();
})

function allowed(ctx){
    if (ctx.updateType != 'callback_query' && ctx.updateType != 'message'){
        console.log(`Update type: ${ctx.updateType} not allowed`)
        return false
    }
    if (ctx.update[ctx.updateType].from) {
        const user = ctx.update[ctx.updateType].from
        const access = bot_config["access"]
        if (access && access.includes(user.id+"")) return true;
        else {
            message = "You are not allowed to run any request using this bot.\nContact the bot manager and ask him to include you using the id: " + user.id
            ctx.reply(message, Extra.HTML())            
        }
    }
    return false;
}

//fill the help with the list of commands and their description
help = bot_config["help_message"]
commands_help = ""
if (help) commands_help = `${help}\n\n`;
commands_help += "Commands:\n"

bot_config["requests"].forEach(req => {
    commands_help += `/${req.command} ${req.help}\n`;
});
commands_help += "/help Show this help message.\n";

// on help, show te description and the command keyboard
bot.help((ctx) => ctx.reply(commands_help,
    Markup.keyboard(keys)
    .oneTime()
    .resize()
    .extra()
));

// list of methods and order they will be called in on each command
const command_middleware = [
    processChoiceParameters,
    confirmRequest,
    executeRequest
]

// iterate over requests definition and declare the middleware methods for each
bot_config["requests"].forEach(req => {
    bot.command(req.command, 
        (ctx, next)=>{
            if (!ctx.session.activeCommands) ctx.session.activeCommands = {}

            //cancel menus of active commands
            for (const id in ctx.session.activeCommands) {
                if (ctx.session.activeCommands.hasOwnProperty(id)) {
                    cancelInlineMenu(ctx, id, `another command was run`)                    
                }
            }
            
            //set a new active command on the session, no menu yet
            const uuid = uuidv1()
            ctx.state.commandId = uuid
            ctx.session.activeCommands[uuid] = {
                uuid: uuid,
                req: JSON.parse(JSON.stringify(req)), //store a copy of the request, it may be modified by dynamic choices
                view: {}
            }
            
            console.log(`/${req.command} requested.`)
            return next()
        }, 
        processInlineParameters, 
        ...command_middleware
    );
});

const regex = /^\/([^@\s]+)@?(?:(\S+)|)\s?([\s\S]+)?$/i;
function processInlineParameters(ctx, next){
    const command = ctx.session.activeCommands[ctx.state.commandId]
    const req = command.req
    //find the parameters in the command and fill the view object
    if (req.params_inline) {
        console.log(`/${req.command} processing inline parameters.`)
        const inline = req.params_inline;
        console.log(`Message: ${ctx.message.text.trim()}`)
        const parts = regex.exec(ctx.message.text.trim());
        if (parts) {
            const args = !parts[3] ? [] : parts[3].split(/\s+/).filter(arg => arg.length);
            if (args) {
                if (args.length < inline.length) {
                    error = `/${req.command} requires <b>${inline.length}</b> positional argument${(inline.length > 1 ? "s:" : ":")}`
                    help = ""
                    for (let i = 0; i < inline.length; i++) {
                        const param = inline[i];
                        help += `\n<b>${param.name}</b>: ${param.help}`
                    }
                    ctx.reply(error + help, Extra.HTML())
                    return
                }
                else {
                    for (let i = 0; i < inline.length; i++) {
                        const param = inline[i];
                        command.view[param.name] = args[i]
                    }
                    return next()
                }
            }
        }
        console.log(`There was an error parsing the command: ${ctx.message.text.trim()}`)
        return
    }
    else{
        return next()
    }
}

function processChoiceParameters(ctx, next) {
    const command = ctx.session.activeCommands[ctx.state.commandId]
    if (!command.req.params_choice) return next()
    const create_menu = !command.menu
    if (create_menu) command.menu = { step: 0 }
    //find the parameters in the command and fill the view object
    const req = command.req
    if (req.params_choice.length > command.menu.step ) {
        const choice = req.params_choice[command.menu.step]
        console.log(`/${req.command} processing choice parameter: ${choice.name}.`)

        //this gets the options instantly if static and does the request if dynamic
        getOptions(choice.options, command.view).then((options)=>{
            //replace the options key with the request result
            choice.options = options
            //fill the keyboard with the options
            const keyboard = []
            const included = []
            for (let i = 0; i < options.length; i++) {
                const c = options[i];
                if (!included.includes(c)) {
                    const value = `${command.uuid},${command.menu.step},${i}`;
                    //the format is uuid,menu_step,option_index
                    //when query_callback is called with this data it will extract the required information
                    keyboard.push(Markup.callbackButton(c, value))
                    included.push(c)
                }
            }

            keyboard.push(Markup.callbackButton("❌ Cancel Request", `${command.uuid},${command.menu.step},${-1}`))

            function wrap(btn, index, currentRow) {
                return currentRow.length == 2 || index == keyboard.length - 1
            }

            //if first menu in the list of choice options then reply with new message
            if (create_menu) {
                ctx.reply(choice.help, Markup.inlineKeyboard(keyboard, {
                        wrap: wrap
                    }).extra())
                    .then((results) => {
                        command.menu.message_id = results.message_id;
                        command.menu.chat_id = results.chat.id;
                    })
            } else {
                //edit the existing menu if not the first
                bot.telegram.editMessageText(
                    command.menu.chat_id,
                    command.menu.message_id, null,
                    choice.help, Markup.inlineKeyboard(keyboard, {
                        wrap: wrap
                    }).extra()
                )
            }
        },(error)=>{
            //this is if there is an error on the dynamic choice options request
            console.log(`Error requesting the "${choice.name}" options array`)
            console.log(error)
            cancelInlineMenu(ctx, command.uuid,`error requesting the "${choice.name}" options`)
        })        
    }
    else{        
        return next()
    }
}

function getOptions(options, view){
    return new Promise((resolve, reject)=>{
        if (Array.isArray(options)) {
            resolve(options)
        }
        else {
            //replace the values of the view object on the options of the dynamic choice request
            const replaced = Mustache.render(JSON.stringify(options), view);
            request(JSON.parse(replaced), (error, response, body) => {
                if (error) {
                    reject(error)                   
                } else {
                    resolve(JSON.parse(body))
                }
            });

        }

    }) 
    
}

//control usage access to commands
bot.use((ctx, next) => {
    //handle actions on inline menus
    if (ctx.updateType == 'callback_query') {
        //extract the data from the payload
        const data = ctx.update.callback_query.data.split(",");
        const uuid = data[0]
        const menu_index = data[1]
        const option_index = data[2]

        ctx.state.commandId = uuid
        //if is an active command
        if(uuid in ctx.session.activeCommands){
            const command = ctx.session.activeCommands[uuid]
            //if the option is negative it means cancel the command, this is the case in the cancel button of each menu
            //and in the cancel button in case of confirmation: true
            if(option_index<0){
                cancelInlineMenu(ctx,uuid,"cancel was pressed")
            }
            else{
                //index "c" means is the confirmation menu so set confirmed to true
                if(menu_index=="c"){
                    command.confirmed = true;
                    return next()
                }
                else{
                    //set the selected choice in the view and increase the step
                    const choice = command.req.params_choice[menu_index]
                    command.view[choice.name] = choice.options[option_index]
                    command.menu.step += 1
                    return next()
                }
            }  
        }
    }
}, 
...command_middleware)

function cancelInlineMenu(ctx, commandId, reason) {
    //this cancels the command and removes it from the active commands list
    const command = ctx.session.activeCommands[commandId];
    if (command) {
        const cancel_message = `❌ /${command.req.command} aborted: ${reason}.`
        if(command.menu && command.menu.message_id){
            const menu = command.menu
            bot.telegram.editMessageText(menu.chat_id, menu.message_id, null, cancel_message)
        }
        else{
            ctx.reply(cancel_message, Extra.HTML())
        }   
        delete ctx.session.activeCommands[commandId];
    }
}

function confirmRequest(ctx, next){
    const command = ctx.session.activeCommands[ctx.state.commandId]

    //if confirmed go ahead
    if(!command.req.confirm || command.confirmed) return next()

    const keyboard = [
        Markup.callbackButton("❌ Cancel", `${command.uuid},c,-1`),
        Markup.callbackButton("✅ Ok", `${command.uuid},c,1`)
    ]

    const confirmation = `Confirm /${command.req.command}\n${getParamList(command.view)}`
    
    //the confirmation may be the first menu, so modify it or create it. 
    if (command.menu && command.menu.message_id) {
        const menu = command.menu
        bot.telegram.editMessageText(
            menu.chat_id, 
            menu.message_id, null, 
            confirmation, 
            Extra.HTML().markup(m => m.inlineKeyboard(keyboard)))        
    }
    else {
        command.menu = { step: 0 }
        ctx.reply(confirmation, Extra.HTML().markup(m => m.inlineKeyboard(keyboard))).then((results) => {
            command.menu.message_id = results.message_id;
            command.menu.chat_id = results.chat.id;
        })        
    }    
}

function executeRequest(ctx, next) {
    const command = ctx.session.activeCommands[ctx.state.commandId]
    const req = command.req
    const view = command.view

    const running_message = `⏳ /${command.req.command} running...\n${getParamList(command.view)}`;

    //the message with the status of the command may be the first response, so modify it or create it. 
    if(command.menu && command.menu.message_id){
        const menu = command.menu
        bot.telegram.editMessageText(menu.chat_id, menu.message_id, null, running_message, Extra.HTML())
        delete ctx.session.activeCommands[command.uuid];
    }
    else{
        command.menu = { step: 0 }
        ctx.reply(running_message, Extra.HTML()).then((results) => {
            command.menu.message_id = results.message_id;
            command.menu.chat_id = results.chat.id;
        })
    }

    //replace the values of the view object on the options of the request
    const replaced = Mustache.render(JSON.stringify(req.options), view);
    req.options = JSON.parse(replaced)


    request(req.options, (error, response, body) => {

        if (error) {
            console.log(`There was an error on the request triggered by: ${req.command}`)
            console.log(error)
            console.log(`Options:\n${req.options}`)
            
            bot.telegram.editMessageText(
                command.menu.chat_id,
                command.menu.message_id, 
                null, 
                `❌ /${command.req.command} error.\n${getParamList(command.view)}`,
                Extra.HTML())
        }
        else {
            message = getMessageContent(req, ctx, response, body, view, false);
            if (message != null && message != "") ctx.reply(message, Extra.HTML())
            broadcastRequest(req, ctx, response, body, view);

            bot.telegram.editMessageText(
                command.menu.chat_id,
                command.menu.message_id,
                null,
                `✅ /${command.req.command} done.\n${getParamList(command.view)}`,
                Extra.HTML())            
        }

        delete ctx.session.activeCommands[command.uuid];
        return next()
    });
}

function broadcastRequest(req, ctx, response, body, view){
    if (!bot_config.channels || bot_config.channels.length==0) return;
    
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
        message += `📢 <b>/${req.command}</b> was called`;
        if (content.includes("username")) message = `${message} by <b>${getUserName(ctx)}</b>`
        message = `${message}.\n`
    }    
    if (content.includes("params")) message += getParamList(view)
    if (content.includes("http_code")) message += getHttpCodeMessage(response)
    if (content.includes("headers")) message += getHttpHeaders(response)
    if (content.includes("body")) message += `📦 Response:\n${body}\n`

    return message
}

function getParamList(view) {
    message = "";
    for (const param in view) {
        if (view.hasOwnProperty(param)) {
            const value = view[param];
            message += `🏷 <b>${param}</b>: ${value}\n`
        }
    }
    return message;
}

function getHttpHeaders(response) {
    message="";
    for (const header in response.headers) {
        if (response.headers.hasOwnProperty(header)) {
            const val = response.headers[header];
            message += `📋 <i>${header}</i>: ${val}\n`
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
    return `${emoji}${code} ${response.statusMessage}\n`;
}

function getUserName(ctx){
    var from = ctx.update.message.from;
    if (from.first_name) return `${from.first_name} ${from.last_name}`
    else return `@${from.username}`
}

bot.catch(function (err) {
    console.log(err);
});

// Launch bot
console.log("Connecting to Telegram...")

bot.launch().then(()=>{
    console.log("Connected.")
})


