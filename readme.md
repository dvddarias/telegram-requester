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

To use this bot you need to create a `config.json` file with the bot details and a list of http requests options, for example:

```json
{
    "bot_token":"REPLACE_THIS_WITH_A_VALID_BOT_ID",
    "start_message": "This bot is to tryout Telegram Requester",
    "help_message": "This is a very simple bot that pings an http api",
    "access":[ "SOME_USER_ID" ],
    "requests": [
        {
            "command": "ping",
            "help": "Check wether he api is listening to the bot.",
            "options": {
                "method": "GET",
                "url": "http://my.website.com/hooks/ping",
            },
            "broadcast": ["http_code", "headers", "username"],
            "response": ["http_code", "body"]
        },
    ]
}
```

## Docker

To run it on a docker container mount the `config.json` file on the `/bot/config.json` path:

```bash
docker run -v `pwd`/config.json:/bot/config.json dvdarias/telegram-requester
```

### Docker-Compose

```yml
services:
  bot:
    image: dvdarias/telegram-requester
    volumes:
      - ./config.json:/bot/config.json
```
