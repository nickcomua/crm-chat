# CRM Chat

The product being rebuilt as a local Telegram client. Two shells open one page.

## Language

**Shell**:
One opening of the product page. This product has a web shell and a desktop shell.
_Avoid_: app, client, frontend

**Web shell**:
The shell that opens the page in a browser.
_Avoid_: web app, site, frontend

**Desktop shell**:
The shell that opens the page in a desktop window.
_Avoid_: native app, desktop app, Tauri app

**Page**:
The one UI both shells open.
_Avoid_: screen, view, frontend

## Chats

**Chat**:
A dialog, a group, or a channel.
_Avoid_: conversation, thread, peer, dialog

**Chat list**:
The list of chats the page shows.
_Avoid_: dialog list, sidebar, inbox

**Dialog**:
A private chat, including the chat with yourself.
_Avoid_: DM, direct message, user, Telegram dialog

**Saved Messages**:
The dialog with yourself.
_Avoid_: favorites, saved, cloud drafts

**Group**:
A multi-person chat, including a supergroup. Not a broadcast channel.
_Avoid_: channel, room, supergroup

**Channel**:
A broadcast chat. A supergroup is not a channel.
_Avoid_: feed, group, supergroup

**Chat id**:
The identity of one chat.
_Avoid_: peer id, external id, username
