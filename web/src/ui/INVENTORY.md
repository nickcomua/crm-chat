# UI kit inventory

Components the crm-chat page needs. The page is the one UI both shells open. Chat words follow the repo glossary: chat list, dialog, group, channel.

Status is the kit under `web/src/ui/`, not the ad hoc login and chat list in `web/src/main.ts`.

| Status  | Meaning                                                      |
| ------- | ------------------------------------------------------------ |
| ready   | Folder exists with a Foldkit view, styles, tests, and a demo |
| missing | Not in the kit yet                                           |

shadcn names match [ui.shadcn.com](https://ui.shadcn.com). "Composed" means the kit piece is product UI built from those primitives, not a single shadcn component.

## Foundation

| Component                 | Status  | shadcn                                                            | Page use                                                                              |
| ------------------------- | ------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Theme tokens and switcher | ready   | theming (CSS variables). Switcher follows the Radio Group pattern | System, light, and dark. Telegram blue `#3390ec`, Web K surfaces. `web/src/ui/theme/` |
| Button                    | ready   | Button                                                            | Send, login, header actions. `web/src/ui/button/`                                     |
| Icon button               | missing | Button                                                            | Attach, emoji, mute, more. No separate kit folder yet                                |
| Label                     | ready   | Label                                                             | Fields. `web/src/ui/label/`                                                           |
| Input                     | ready   | Input, Field                                                      | Phone, code, search, case and contact fields. `web/src/ui/input/`                     |
| Textarea                  | ready   | Textarea                                                          | Composer, notes. `web/src/ui/textarea/`                                               |
| Checkbox                  | ready   | Checkbox                                                          | Select messages, table rows, filters. `web/src/ui/checkbox/`                          |
| Radio group               | ready   | Radio Group                                                       | One-of settings. `web/src/ui/radio-group/`                                            |
| Switch                    | ready   | Switch                                                            | Notifications, mute. `web/src/ui/switch/`                                             |
| Select                    | missing | Select                                                            | Case status, assignee                                                                 |
| Combobox                  | missing | Combobox                                                          | Contact picker, tag picker                                                            |
| Slider                    | missing | Slider                                                            | Not required for the current page                                                     |
| Form                      | ready   | Form, Field                                                       | Login and case editors. `web/src/ui/form-field/`                                      |

## Overlays and menus

| Component       | Status  | shadcn        | Page use                                 |
| --------------- | ------- | ------------- | ---------------------------------------- |
| Dialog          | missing | Dialog        | Profile, forward, create case            |
| Alert dialog    | missing | Alert Dialog  | Delete, leave group, discard notes       |
| Sheet           | missing | Sheet         | Chat info when the page is narrow        |
| Drawer          | missing | Drawer        | Same as sheet on a short window          |
| Popover         | missing | Popover       | Emoji, reactions, reminder date          |
| Dropdown menu   | missing | Dropdown Menu | Attach, header more, account menu        |
| Context menu    | missing | Context Menu  | Message actions                          |
| Command palette | missing | Command       | Jump to a chat, case, contact, or action |
| Tooltip         | missing | Tooltip       | Icon buttons                             |
| Toast           | missing | Sonner        | Send failure, reminder fired             |
| Alert           | missing | Alert         | Login and sync errors                    |
| Hover card      | missing | Hover Card    | Contact preview                          |

## Lists, data, and chrome

| Component    | Status  | shadcn       | Page use                                            |
| ------------ | ------- | ------------ | --------------------------------------------------- |
| Avatar       | ready   | Avatar       | Chats, contacts, accounts. `web/src/ui/avatar/`     |
| Badge        | ready   | Badge        | Unread count, tags, case status. `web/src/ui/badge/` |
| Card         | ready   | Card         | Kanban card, case, contact. `web/src/ui/card/`      |
| Table        | missing | Table        | Cases, contacts                                     |
| Data table   | missing | Data Table   | Sort and filter those tables                        |
| Scroll area  | missing | Scroll Area  | Chat list, message history, kanban column, timeline |
| Separator    | ready   | Separator    | Rows and sections. `web/src/ui/separator/`          |
| Skeleton     | ready   | Skeleton     | Loading chats and cases. `web/src/ui/skeleton/`     |
| Empty        | missing | Empty        | No chats, no cases, no notes                        |
| Progress     | missing | Progress     | File upload and download                            |
| Spinner      | ready   | Spinner      | Connecting. `web/src/ui/spinner/`                   |
| Tabs         | missing | Tabs         | Chat folders, case sections. The page folder bar is in `web/src/shellView.ts` (All, Personal, Groups, Channels), not a kit Tabs component |
| Accordion    | missing | Accordion    | Chat info and settings groups                       |
| Resizable    | missing | Resizable    | Chat list column and history column                 |
| Sidebar      | missing | Sidebar      | Chat list column                                    |
| Pagination   | missing | Pagination   | Case and contact tables                             |
| Breadcrumb   | missing | Breadcrumb   | Case inside a board                                 |
| Kbd          | missing | Kbd          | Command palette hints                               |
| Toggle group | missing | Toggle Group | Composer formatting                                 |
| Calendar     | missing | Calendar     | Reminder day                                        |
| Date picker  | missing | Date Picker  | Reminder due                                        |
| Chart        | missing | Chart        | Not required for the current page                   |

## Telegram page

| Component                 | Status  | shadcn                                                            | Page use                                                        |
| ------------------------- | ------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| Login                     | missing | Composed: Field, Input, Button, Alert                             | QR first, then phone, code, and 2FA. Day theme by default, with a theme toggle. No "Keep me signed in" control: a signed-in account always persists in IndexedDB. Page view is `web/src/loginView.ts` |
| Account switcher          | missing | Composed: Dropdown Menu, Avatar                                   | Signed-in accounts                                              |
| Chat list                 | missing | Composed: Scroll Area, Sidebar, Button                            | Dialogs, groups, channels, Saved Messages                       |
| Chat list search          | missing | Composed: Input                                                   | Filter the chat list                                            |
| Chat folders              | missing | Tabs                                                              | Folder bar is implemented on the page in `web/src/shellView.ts` |
| Chat row                  | missing | Composed: Avatar, Badge                                           | Title, last message, unread, muted                              |
| Message history           | missing | Composed: Scroll Area                                             | Incoming and outgoing bubbles                                   |
| Message bubble            | missing | Custom. Tokens: `--telegram-message-in`, `--telegram-message-out` | Text, meta, reply, reactions                                    |
| Composer                  | missing | Composed: Textarea, Button, Popover                               | Draft, send, attach, emoji                                      |
| Reply and edit bar        | missing | Custom                                                            | Quoted message above the composer                               |
| Pinned bar                | missing | Custom                                                            | Pinned message                                                  |
| Attach menu               | missing | Dropdown Menu                                                     | Photo, file, camera                                             |
| Emoji and reaction picker | missing | Popover                                                           | Insert and react                                                |
| File preview              | missing | Composed: Dialog                                                  | Photo, video, document                                          |
| Voice control             | missing | Button, Progress                                                  | Record and play                                                 |
| Scroll to latest          | missing | Button                                                            | Jump to the newest message                                      |

## CRM

| Component        | Status  | shadcn                                  | Page use                                  |
| ---------------- | ------- | --------------------------------------- | ----------------------------------------- |
| Cases table      | missing | Data Table                              | Case list                                 |
| Case detail      | missing | Composed: Card, Tabs, Field             | One case                                  |
| Contacts table   | missing | Data Table, Avatar                      | Contact list                              |
| Contact detail   | missing | Card, Field                             | One contact                               |
| Kanban           | ready   | Composed: Card, Scroll Area, Badge      | Cases by status. `web/src/ui/kanban/`     |
| Tags             | missing | Composed: Badge, Combobox               | Labels on chats and cases                 |
| Reminders        | missing | Composed: Date Picker, Popover, Sonner  | Due date and fired notice                 |
| Notes editor     | missing | Composed: Textarea now. Rich text later | Case and contact notes                    |
| Timeline         | missing | Composed: Scroll Area                   | Case events, messages, reminder changes   |
| Command palette  | missing | Command                                 | Same row as the overlay above             |
| File previews    | missing | Dialog                                  | Same row as the Telegram file preview     |
| Account switcher | missing | Dropdown Menu, Avatar                   | Same row as the Telegram account switcher |
