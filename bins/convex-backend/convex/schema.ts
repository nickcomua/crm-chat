import { defineSchema } from "convex/server";
import { chatsTable } from "./model/chats";
import { clientsTable, deletedClientsTable } from "./model/clients";
import { mediaTable } from "./model/media";
import { messagesTable } from "./model/messages";
import { notificationsTable } from "./model/notifications";
import { phoneAuthsTable } from "./model/phoneAuth";
import { qrAuthsTable } from "./model/qrAuth";

export default defineSchema({
  clients: clientsTable,
  deletedClients: deletedClientsTable,
  chats: chatsTable,
  messages: messagesTable,
  media: mediaTable,
  phoneAuths: phoneAuthsTable,
  notifications: notificationsTable,
  qrAuths: qrAuthsTable,
});
