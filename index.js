const Telegraf = require('telegraf')
const Extra = require('telegraf/extra')
const Markup = require('telegraf/markup')
const session = require('telegraf/session')
const request = require("request");
const Mustache = require("mustache");
const uuidv1 = require('uuid/v1');
const yaml = require('js-yaml');
const fs = require('fs');
const jp = require('jsonpath-plus').JSONPath;
const express = require('express')
const app = express();
const nodeHtmlToImage = require('./node-html-to-image/src/index')


// check and load configuration
if (!process.env.CONFIG){
    process.env.CONFIG = "./config.yml"
}
try {
    var data = fs.readFileSync(process.env.CONFIG, 'utf8');
} catch (error) {
    console.log(`Failed reading bot configuration at: ${process.env.CONFIG}`);
    process.exit(1);
}
// TODO validate the config matches the bot configuration json schema
const bot_config = yaml.safeLoad(data);
// const bot_config = JSON.parse(data);


//-----pre-process the configuration-----
//if env variable is set, override config settings
if (process.env.BOT_TOKEN) bot_config["bot_token"] = process.env.BOT_TOKEN
//if no global parameters or global headers add empty ones
if (!bot_config.parameters) bot_config.parameters = {}
if (!bot_config.headers) bot_config.headers = {}
if (!bot_config.type) bot_config.type = 'private'
if (bot_config.listen){
    if (!bot_config.listen.port) bot_config.listen.port = 3000;
    if (!bot_config.listen.interface) bot_config.listen.interface = "localhost";
} 

//add the name field to each command and empty parameters array
for (const name in bot_config.commands) {
    if (bot_config.commands.hasOwnProperty(name)){
        const command = bot_config.commands[name];
        command.name = name;
        if (!command.parameters) command.parameters=[]
        //separate inline type parameters from choice and input type
        command.params_inline = []
        const params_sorted = []
        for (let i = 0; i < command.parameters.length; i++) {
            const param = command.parameters[i];
            if (param.type === "inline") command.params_inline.push(param);
            else params_sorted.push(param)            
        }
        command.parameters = params_sorted;
    }
}   

//----------------------------------------

//console.log("Bot configuration is set to:\n" + JSON.stringify(bot_config, null, 4));

//to remove an element form an array: I hate this!!!
function arrayRemove(arr, value){return arr.filter(function(ele){return ele != value;});}

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
for (const name in bot_config.commands) {
    if (!bot_config.commands.hasOwnProperty(name)) continue
    const req = bot_config.commands[name];
    keys.push("/" + req.name);    
}

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
        const allowed = bot_config["allowed"]
        const blocked = bot_config["blocked"]
        const is_blocked = blocked && blocked.includes(user.id + "");
        const is_allowed = allowed && allowed.includes(user.id + "");
        if (
            !is_blocked && 
            (bot_config["type"] === "public" || (bot_config["type"] === "private" && is_allowed))
        )
            return true
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
commands_help += "Commands:\n\n"

for (const name in bot_config.commands) {
    if (!bot_config.commands.hasOwnProperty(name)) continue
    const req = bot_config.commands[name];
    commands_help += `/${req.name} ${req.help}\n`;
}
commands_help += "/help Show this help message.\n";

// on help, show te description and the command keyboard
bot.help((ctx) =>{
        var help = commands_help 
        if (ctx && ctx.update && ctx.update.message && ctx.update.message.chat && ctx.update.message.chat.id) {
            help += "\nID: " + ctx.update.message.chat.id;
        }
        ctx.reply(help,
            Markup.keyboard(keys)
            .oneTime()
            .resize()
            .extra()
        );
    }
);

// list of methods and order they will be called in on each command
const command_middleware = [
    processChoiceParameters,
    processQuestionParameters,
    confirmRequest,
    executeRequest
]

// iterate over requests definition and declare the middleware methods for each
for (const name in bot_config.commands) {
    if (!bot_config.commands.hasOwnProperty(name)) continue
    const req = bot_config.commands[name];

    bot.command(req.name, 
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
            ctx.session.waiting = false;
            ctx.session.activeCommands[uuid] = {
                uuid: uuid,
                req: JSON.parse(JSON.stringify(req)), //store a copy of the request, it may be modified by dynamic choices
                view: {
                    __pretty_name__: {}
                }, 
                default_view: JSON.parse(JSON.stringify(bot_config.parameters)), //store a copy of the default parameters
                username: getUserName(ctx),
                menu: {
                    step:0,
                    enabled: false
                }
            }
            
            console.log(`/${req.name} requested.`)
            return next()
        }, 
        processInlineParameters, 
        ...command_middleware
    );
}

function getUserName(ctx) {
    var from = ctx.update.message.from;
    if (from.first_name) return `${from.first_name} ${from.last_name}`
    else return `@${from.username}`
}

const regex = /^\/([^@\s]+)@?(?:(\S+)|)\s?([\s\S]+)?$/i;
function processInlineParameters(ctx, next){
    const command = ctx.session.activeCommands[ctx.state.commandId]
    const req = command.req
    //find the parameters in the command and fill the view object
    if (req.params_inline.length==0) return next()
    const inline = req.params_inline;
    console.log(`/${req.name} processing inline parameters.`)
    console.log(`Message: ${ctx.message.text.trim()}`)
    const parts = regex.exec(ctx.message.text.trim());
    if (parts) {
        const args = !parts[3] ? [] : parts[3].split(/\s+/).filter(arg => arg.length);
        if (args) {
            if (args.length < inline.length) {
                error = `/${req.name} requires <b>${inline.length}</b> positional argument${(inline.length > 1 ? "s:" : ":")}`
                help = ""
                for (let i = 0; i < inline.length; i++) {
                    const param = inline[i];
                    help += `\n<b>${param.name}</b>: ${param.help}`
                }
                ctx.reply(error + help, Extra.HTML())
                delete ctx.session.activeCommands[ctx.state.commandId];
            }
            else {
                for (let i = 0; i < inline.length; i++) {
                    const param = inline[i];
                    command.view[param.name] = args[i];
                    command.view.__pretty_name__[param.name] = args[i];
                }
                return next()
            }
        }
    }
    console.log(`There was an error parsing the command: ${ctx.message.text.trim()}`)
}

function processChoiceParameters(ctx, next) {
    const command = ctx.session.activeCommands[ctx.state.commandId];
    const req = command.req;

    if (req.parameters.length==0) return next()

    //find the current parameter in the command and fill the view object
    if (req.parameters.length > command.menu.step && req.parameters[command.menu.step].type ==="choice") {
        const choice = req.parameters[command.menu.step]
        console.log(`/${req.name} processing choice parameter: ${choice.name}.`)

        //this gets the options instantly if static and does the request if dynamic
        getOptions(choice.options, command).then((options)=>{
            //if is a list of strings move it to the format "{ name:, value: }"
            choice.options = expandOptions(options);

            if(choice.options.length==0){
                cancelInlineMenu(ctx, command.uuid, `empty "${choice.name}" options`)
                return
            }
            //fill the keyboard with the options
            const keyboard = []
            const included = []
            for (let i = 0; i < choice.options.length; i++) {
                const c = choice.options[i];
                if (!included.includes(c)) {
                    const value = `${command.uuid},${command.menu.step},${i}`;
                    //the format is uuid,menu_step,option_index
                    //when query_callback is called with this data it will extract the required information
                    keyboard.push(Markup.callbackButton(c.name, value))
                    included.push(c)
                }
            }

            keyboard.push(Markup.callbackButton("❌ Cancel", `${command.uuid},${command.menu.step},${-1}`))

            function wrap(btn, index, currentRow) {
                return currentRow.length == 2 || index == keyboard.length - 1
            }

            //if first menu in the list of choice options then reply with new message
            if (command.menu.enabled) {
                bot.telegram.editMessageText(
                    command.menu.chat_id,
                    command.menu.message_id, null,
                    choice.help, Markup.inlineKeyboard(keyboard, {
                        wrap: wrap
                    }).extra()
                )
            } else {
                ctx.reply(choice.help, Markup.inlineKeyboard(keyboard, {
                    wrap: wrap
                }).extra())
                    .then((results) => {
                        command.menu.message_id = results.message_id;
                        command.menu.chat_id = results.chat.id;
                        command.menu.enabled = true;
                    });

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

//if is a list of strings move it to the format "{ name:, value: }"
function expandOptions(options){
    const result = []
    for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        if(opt===null) continue;
        if(typeof opt === 'string'){
            if(opt!=="") result.push( { name: opt, value: opt })
        }
        else if(typeof opt === 'object'){
            if(opt.name && opt.name!=="" && opt.name!==null && !opt.value){
                opt.value = opt.name;
            }
            result.push(opt)
        }
    }
    return result;
}

function getOptions(options, command){
    return new Promise((resolve, reject)=>{
        if (Array.isArray(options)) {
            resolve(options)
        }
        else {
            //replace the values of the command views on the options of the dynamic choice request
            var options_string = JSON.stringify(options)

            const render_view = JSON.parse(JSON.stringify(command.view))
            for (const key in command.default_view) {
                if (command.default_view.hasOwnProperty(key) && !render_view.hasOwnProperty(key)) {
                    render_view[key] = command.default_view[key]
                }
            }
            options_string = Mustache.render(options_string, render_view);
            options_object = JSON.parse(options_string);

            request(options_object, (error, response, body) => {
                if (error) {
                    reject(error)                   
                } else {
                    resolve(JSON.parse(processJSONResponse(options_object.json_query, body)))
                }
            });
        }
    }) 
}

function processQuestionParameters(ctx, next) {
    const command = ctx.session.activeCommands[ctx.state.commandId];
    const req = command.req;
    if (req.parameters.length == 0) return next()

    //find the current parameter in the command and fill the view object
    if (req.parameters.length > command.menu.step && req.parameters[command.menu.step].type === "question") {
        const question = req.parameters[command.menu.step]
        console.log(`/${req.name} processing question parameter: ${question.name}.`)

        ctx.session.waiting = ctx.state.commandId;

        //if first menu in the list of choice options then reply with new message
        if (!command.menu.enabled) {
            ctx.reply(question.help,Extra.HTML());
        } else {
            //edit the existing menu if not the first
            bot.telegram.editMessageText(
                command.menu.chat_id,
                command.menu.message_id, null,
                question.help,Extra.HTML())
        }
        command.menu.enabled = false;
    }
    else {
        return next()
    }
}

//control usage access to commands
bot.use((ctx, next) => {
    //handle actions on inline menus
    if (ctx.updateType === 'callback_query') {
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
                    const choice = command.req.parameters[menu_index];
                    command.view[choice.name] = choice.options[option_index].value;
                    command.view.__pretty_name__[choice.name] = choice.options[option_index].name;
                    command.menu.step += 1;
                    return next()
                }
            }  
        }
    }
    else if(ctx.updateType==='message' && ctx.session.waiting){
        ctx.state.commandId = ctx.session.waiting;
        const command = ctx.session.activeCommands[ctx.session.waiting]
        ctx.session.waiting = false;
        //set the selected choice in the view and increase the step
        const question = command.req.parameters[command.menu.step];
        command.view[question.name] = ctx.update.message.text;
        command.view.__pretty_name__[question.name] = ctx.update.message.text;
        command.menu.step += 1;
        return next()
    }
}, 
...command_middleware)


function cancelInlineMenu(ctx, commandId, reason) {
    //this cancels the command and removes it from the active commands list
    const command = ctx.session.activeCommands[commandId];
    if (command) {
        const cancel_message = `❌ /${command.req.name} aborted: ${reason}.`
        if(command.menu.enabled){
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
    const param_list = getParamList(command.view);
    const confirmation = `Confirm /${command.req.name}${param_list==""?".":" with:\n"+param_list}`
    
    //the confirmation may be the first menu, so modify it or create it. 
    if (command.menu.enabled) {
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
            command.menu.enabled = true;
        })        
    }    
}

function executeRequest(ctx, next) {
    const command = ctx.session.activeCommands[ctx.state.commandId]
    const req = command.req
    const view = command.view

    const running_message = `⏳ /${command.req.name} running...\n${getParamList(view)}`;

    //this promise will be waited on to modify the message again
    var edit_message_promise;
    
    //the message with the status of the command may be the first response, so modify it or create it.
    if(command.menu.enabled){
        const menu = command.menu
        edit_message_promise = bot.telegram.editMessageText(menu.chat_id, menu.message_id, null, running_message, Extra.HTML())
    }
    else{
        command.menu = { step: 0 }
        edit_message_promise = ctx.reply(running_message, Extra.HTML()).then((results) => {
            command.menu.message_id = results.message_id;
            command.menu.chat_id = results.chat.id;
            command.menu.enabled = true;
        })
    }

    //if request is empty do nothing
    if(!req.request){
        edit_message_promise.then((results) => {
            bot.telegram.editMessageText(
                command.menu.chat_id,
                command.menu.message_id,
                null,
                `✅ /${command.req.name} did nothing.\n${getParamList(view)}`,
                Extra.HTML())
        })
        delete ctx.session.activeCommands[command.uuid];
        return next()
    }

    //replace the values of the command views on the options of the dynamic choice request
    var options_string = JSON.stringify(req.request)

    const render_view = JSON.parse(JSON.stringify(view))
    for (const key in command.default_view) {
        if (command.default_view.hasOwnProperty(key) && !render_view.hasOwnProperty(key)) {
            render_view[key] = command.default_view[key]
        }
    }
    options_string = Mustache.render(options_string, render_view);
    req.request = JSON.parse(options_string)

    // if (!req.request.headers) req.request.headers={}
    // //include default headers in the request
    // for (const header in bot_config.headers) {
    //     if (bot_config.headers.hasOwnProperty(header) && !req.request.headers.hasOwnProperty(header)) {
    //         req.request.headers[header] = bot_config.headers[header]
    //     }
    // }

    // req.request.rejectUnauthorized = false;
    request(req.request, (error, response, body) => {

        if (error) {
            console.log(`There was an error on the request triggered by: ${req.name}`)
            console.log(error)
            console.log(`Options:\n${req.request}`)
            
            bot.telegram.editMessageText(
                command.menu.chat_id,
                command.menu.message_id, 
                null, 
                `❌ /${command.req.name} error.\n${getParamList(view)}`,
                Extra.HTML())
        }
        else {
            getMessageContent(req, command.username, response, body, view, false).then((message_content)=>{
                if (message_content != null) {
                    message = message_content.message;
                    image = message_content.image;
                    if(message!=""){
                        if(image!=null){
                            ctx.replyWithPhoto(
                            image,
                            Extra.caption(message).HTML()
                            );
                        }
                        else{
                            ctx.reply(message, Extra.HTML());
                        }
                    }
                    else if(image != null){
                        ctx.replyWithPhoto(
                            image
                        );
                    }
                }
                broadcastRequest(req, command.username, response, body, view);
    
                edit_message_promise.then((results)=>{
                    bot.telegram.editMessageText(
                        command.menu.chat_id,
                        command.menu.message_id,
                        null,
                        `✅ /${command.req.name} done.\n${getParamList(view)}`,
                        Extra.HTML())                            
                })
            });
        }

        delete ctx.session.activeCommands[command.uuid];
        return next()
    });
}

function broadcastRequest(req, username, response, body, view){
    if (!bot_config.broadcast_channels || bot_config.broadcast_channels.length == 0) return;
    
    getMessageContent(req, username, response, body, view, true).then((message_content)=>{
        bot_config["broadcast_channels"].forEach(channelId => {
            if (message_content != null) {
                message = message_content.message;
                image = message_content.image;
                if (message != "") {
                    if (image != null) {
                        bot.telegram.sendPhoto(
                            channelId,
                            image,
                            Extra.caption(message).HTML()
                        );
                    } else {
                        bot.telegram.sendMessage(
                            channelId,
                            message, 
                            Extra.HTML()
                        );
                    }
                } else if (image != null) {
                    bot.telegram.sendPhoto(
                        channelId,
                        image
                    );
                }
            }
    
            bot.telegram.sendMessage(channelId, message, Extra.HTML())
        });
    });
}


function sendMessage(message, channelIds) {
    if (message == null || message == "") return;
    channelIds.forEach(channelId => {
        bot.telegram.sendMessage(channelId, message, Extra.HTML())
    });
}

function getMessageContent(req, username, response, body, view, is_broadcast){
    return new Promise((resolve, reject) => {
        response_config = is_broadcast?req.broadcast:req.response;    
        result = {
            message: "",
            image: null
        };
        if (!response_config) return result;
        if (response_config.include){
            if (response_config.include.includes("command")) result.message += `📢 <b>/${req.name}</b> called\n`;
            if (response_config.include.includes("username")) result.message += `by: <b>${username}</b>\n`
            if (response_config.include.includes("params")) result.message += getParamList(view)
            if (response_config.include.includes("http_code")) result.message += getHttpCodeMessage(response)
            if (response_config.include.includes("headers")) result.message += getHttpHeaders(response)
        }
        if(response_config.body){
            if (response_config.body.type === "json") {
                result.message += `📦 Response:\n${processJSONResponse(response_config.body.json_query, body)}\n`
                resolve(result);
            }
            else if (response_config.body.type === "image") {
                result.image = { url: req.request.url }
                resolve(result);
            }
            else if (response_config.body.type === "html") {
                nodeHtmlToImage({
                    url: req.request.url,
                    waitUntil: ["load"],
                    puppeteerArgs:{ 
                        args:["--no-sandbox"],
                        defaultViewport: response_config.body.viewport,
                    } 
                }).then((image)=>{
                    result.image = { source: image }
                    resolve(result);
                });
            }
        }        
    });
}

function processJSONResponse(json_query, body){
    var response_body = body

    if(json_query){        
        var format = json_query.format
        if(!format) format = "list"
        const query = json_query.query

        const paths = jp( { json: JSON.parse(body), path: query, resultType: "all" } );

        if (format === "list") {
            response_body = []
            for (let i = 0; i < paths.length; i++) {
                const p = paths[i];
                response_body.push(p.value);
            }
            response_body = JSON.stringify(response_body)
        }
        else if (format === "path") {
            response_body = ""
            for (let i = 0; i < paths.length; i++) {
                const p = paths[i];
                response_body += `<i>${p.pointer.substr(1)}</i>: ${p.value}\n`
            }
        }
    }
    return response_body
}

function getParamList(view) {
    message = "";
    for (const param in view) {
        if (view.hasOwnProperty(param) && param != "__pretty_name__") {
            const value = view.__pretty_name__[param];
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

bot.catch(function (err) {
    console.log(err);
    if (!bot.context.botInfo) {
        console.log("Retrying connection in 10 seconds...")
        setTimeout(() => {
            launchBot();
        }, 10000);
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.post('/message', (req, res) => {
    var error = "";
    if(!req.body.message){
        error+="The `message` field is required.\n"
    }
    if(!req.body.channels){
        error+="The `channels` list field is required.\n"
    }
    if(error===""){
        sendMessage(req.body.message, req.body.channels);
        return res.sendStatus(200);
    }
    else{
        return res.status(422).send(error);
    }

})

function startListening() {
    app.listen(bot_config.listen.port, bot_config.listen.interface, () => {
        console.log(`Listening at ${bot_config.listen.interface}:${bot_config.listen.port}...`)
    });    
}
// Launch bot

function launchBot(){
    console.log("Connecting to Telegram...")
    bot.launch().then(()=>{
        if (bot.context.botInfo){
            console.log("Connected.");    
            if(bot_config.listen) startListening();
        }
        else{
            console.log("Retrying in 10 seconds...")
            setTimeout(() => {
                launchBot();
            }, 10000);
        }
    })    
}

launchBot();



