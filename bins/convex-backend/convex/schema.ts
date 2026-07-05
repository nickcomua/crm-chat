import { defineSchema } from "convex/server";
import { chatContactLinksTable } from "./model/chatContactLinks";
import { chatsTable } from "./model/chats";
import { clientsTable, deletedClientsTable } from "./model/clients";
import { contactFactsTable } from "./model/contactFacts";
import { contactPinsTable } from "./model/contactPins";
import { contactPresenceTable } from "./model/contactPresence";
import { contactsTable } from "./model/contacts";
import { mediaTable } from "./model/media";
import { messagesTable } from "./model/messages";
import { notificationsTable } from "./model/notifications";
import { outgoingMessagesTable } from "./model/outgoingMessages";
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
	contacts: contactsTable,
	contactFacts: contactFactsTable,
	contactPins: contactPinsTable,
	contactPresence: contactPresenceTable,
	chatContactLinks: chatContactLinksTable,
	outgoingMessages: outgoingMessagesTable,
});
