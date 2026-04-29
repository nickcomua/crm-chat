export function formatMessageTime(ts: number): string {
	const date = new Date(ts);
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDateHeader(ts: number): string {
	const date = new Date(ts);
	const now = new Date();
	const isToday = date.toDateString() === now.toDateString();

	if (isToday) {
		return "Today";
	}

	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (date.toDateString() === yesterday.toDateString()) {
		return "Yesterday";
	}

	return date.toLocaleDateString([], {
		weekday: "long",
		month: "long",
		day: "numeric",
	});
}
