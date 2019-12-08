# Telegram Requester

A Telegram bot that runs custom HTTP requests.

## Usecase

This bot allows you to call any HTTP api using Telegram. I internally use it to control the deployment of a website using web-hooks.

For example, in a private chat with the bot, running the command: `/deploy feature/betterui` it runs an http request to the endpoint `https://my.website.com/hooks/deploy?branch=feature/betterui` and responds with the deployment status.

It also sends a message to a team channel so everyone knows what is happening.

## Features:

- Maps multiple Telegram commands to HTTP requests.
- Responds to a command with a message that can optionally include: the http response code, headers and body.
- Includes positional arguments on the commands that can be used on the request specification.
- Broadcasts the command results to specific channel.
- User access control list to limit which users can use the commands.

## Configuration

To use this bot you need to create a `config.yml` file with the bot details and a list of http requests, for example:

```yml
bot_token: "REPLACE_THIS_WITH_A_VALID_BOT_ID"
start_message: "This bot is to tryout Telegram Requester"
help_message: "This is a very simple bot that pings an http api"
access: [ "SOME_USER_ID" ]
channels: [ "SOME_CHANNEL_ID" ]
commands:
    ping:
        help: "Check wether he api is listening to the bot."
        request:
            method: "GET"
            url: "http://my.website.com/hooks/ping"
        broadcast: ["http_code", "headers", "username"]
        response: ["http_code", "body"]
```

### Options:

`bot_token`: *string*. Token that uniquely identifies your bot

To create a Telegram Bot, you first have to [get a bot account](https://core.telegram.org/bots) by [chatting with BotFather](https://core.telegram.org/bots#6-botfather).

BotFather will give you a token, something like `123456789:AbCdfGhIJKlmNoQQRsTUVwxyZ`, this is the string you have to use.

---

`start_message`: *string*. Message that will be used when starting a new chat with the bot.

`help_message`: *string*. Header of the help message sent by the `/help` command. In the body it will automatically include the list of available commands/requests and their description.

---

`access`: *list*. Ids of the users allowed to interact with the bot.

If a user starts a chat with the bot and is not on this list, the bot will send him a message telling that is not allowed and will include the id that needs to be included in the access list.  

---

`channels`: *list*. Ids of the channels the bot will broadcast the command results to. They can be in the form `@mychannel` if public or `-10055734923488` if private.

On each command/request you can specify how the bot will respond to it. With the `broadcast` option you can send parts of the response to a this list of channels.

*Note*: The bot has to be included as an Admin in the channel for it to be able to send messages to it.

*Note*: To get the numeric id of a private channel, include the bot as an Admin and send the command `/id`, the bot will respond with the information of the channel.

---

`commands`: *object*. Commands that can trigger HTTP requests. Each command object can have the following options:

- `name`: *string*. This is the name of the command in telegram, and the id of the request/command, it must be unique.
- `help`: *string*. The help message explaining what this command does, it is shown on `/help`.
- `response`: *list*. Parts of the http response that will be included on the response to the command, the possible options are: `"http_code", "params", "body", "headers"`. To skip the response do not include this key.
- `broadcast`: *list*. Parts of the http response that will be broadcasted to the channel list in the `channels` option, the possible options are: `"http_code", "params", "body", "headers", "username"`. To skip broadcasting to the channels do not include this key.
- `params_inline`: *list*. This is the list of inline parameters of the command. Each parameter has: `name`-the name of the command, and `help`- the description of the command.  Inline parameters need to be included with the command. For example:

```yml
name: "register",
params_inline:
  -
    name: "name"
    help: "The name of the user."
  -
    name: "last_name",
    help: "The last name of the user."
```

This is a `/register` command with two inline parameters: `name` and `last_name`. To call this command the message has to include two positional arguments. For example in `/register tony stark`, the value of the parameters are `name:tony` and `last_name:stark` both values will be interpolated in the `request` object wherever `{{{name}}}` and `{{{last_name}}}` is found.

- `params_choice`: *list*. This is the list of choice parameters. Each parameter has: `name`-the name of the command, `help`-message included in the menu and `options`-list of possible options to choose from. Choice parameters are shown as a menu with a list of possible options for each parameter. For example:

```yml
command: "register"
params_choice:
  -
    name: "name"
    help: "What is your name?"
    options: ["David", "Tony", "Scarlet"]
  -
    name: "last_name",
    help: "What is your last name?",
    options: ["Copperfield", "Stark", "Johansson"]
```

This is a `/register` command with two multiple choice parameters: `name` and `last_name`. After calling this command the user will be presented with a menu to choose the value each parameter will have. As with all parameters both values will be interpolated in the `request` object wherever `{{{name}}}` and `{{{last_name}}}` is found.

- `confirm`: *boolean*. When `true` it will show a confirm dialog with all the parameter values before running the request.

- `request`: *object*. This object contains all the configuration of the http request. All the possible options are thoroughly documented in [the requests.js options documentation](https://github.com/request/request#requestoptions-callback).

The request parameters declared in `params` will be interpolated on any of the properties of the `request` object by using the template syntax `{{{paramter_name}}}`. If you want to make it really easy to generate and test this `request` object, download and install [Postman](https://postman.com/) and use its [code generation option](https://learning.getpostman.com/docs/postman/sending-api-requests/generate-code-snippets/), selecting the `NodeJS -> Request` on the language dropdown.

This would be the configuration for command called `example` with one inline parameter that is used as the value of the `X-Username` header and the query string `username` on the http request.

```yml
commands:
    example:
        params_inline:
          -
            name:"username"
            help:"The name of the user to register"
        request:
            url: "https://somewebsite.com/register"
            headers:
                X-Username: "{{{username}}}"
            qs:
                username: "{{{username}}}"
```

When sending the command `\example ironman`, the bot will make a request to `https://somewebsite.com/register?username=ironman` with the header `X-Username` set to `ironman`.

## Docker

To run it on a docker container mount the `config.yml` file on the `/bot/config.yml` path:

```bash
docker run -v `pwd`/config.yml:/bot/config.yml dvdarias/telegram-requester
```

### Docker-Compose

```yml
services:
  bot:
    image: dvdarias/telegram-requester
    volumes:
      - ./config.yml:/bot/config.yml
```
