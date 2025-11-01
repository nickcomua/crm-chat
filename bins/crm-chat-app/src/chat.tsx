import { RecordId } from "@surrealdb/surrealdb";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, Plus, Search, Target, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Sidebar,
	SidebarContent,
	SidebarInset,
	SidebarProvider,
	SidebarRail,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import type { Chat } from "./app";
import { useLiveQuery } from "./hooks/use-live-query";
import {
	createBoardNote,
	deleteBoardNote,
	updateBoardNote,
} from "./services/board-note-service";
import { searchMessages } from "./services/message-search-service";
import type { BoardNotePatch } from "./types";

type Message = {
	id: string;
	message: string;
	out: boolean;
	is_question: boolean;
	confidence: number;
	answers: string[];
	is_answer: boolean;
};

type QAPair = {
	q: Message;
	answers: Message[];
};

type BoardNote = {
	id: string;
	question_id: string;
	x: number;
	y: number;
	z: number;
	color?: string | null;
	width?: number | null;
	height?: number | null;
};

export type MessageRow = {
	id: { tb: "message"; id: { String: string } };
	chat_id: string;
	client_id: string;
	// content: Array<{
	// 	Telegram: {
	// 		Message: {
	// 			date: number;
	// 			edit_hide: boolean;
	// 			from_scheduled: boolean;
	// 			id: number;
	// 			invert_media: boolean;
	// 			legacy: boolean;
	// 			media_unread: boolean;
	// 			mentioned: boolean;
	// 			message: string;
	// 			noforwards: boolean;
	// 			offline: boolean;
	// 			out: boolean;
	// 			paid_suggested_post_stars: boolean;
	// 			paid_suggested_post_ton: boolean;
	// 			peer_id: {
	// 				User: {
	// 					user_id: number;
	// 				};
	// 			};
	// 			pinned: boolean;
	// 			post: boolean;
	// 			silent: boolean;
	// 			video_processing_pending: boolean;
	// 			media?: {
	// 				Photo?: {
	// 					photo?: {
	// 						Photo: {
	// 							access_hash: number;
	// 							date: number;
	// 							dc_id: number;
	// 							file_reference: number[];
	// 							has_stickers: boolean;
	// 							id: number;
	// 							sizes: Array<
	// 								| {
	// 										PhotoStrippedSize: {
	// 											bytes: number[];
	// 											type: string;
	// 										};
	// 								  }
	// 								| {
	// 										Size: {
	// 											h: number;
	// 											size: number;
	// 											type: string;
	// 											w: number;
	// 										};
	// 								  }
	// 								| {
	// 										Progressive: {
	// 											h: number;
	// 											sizes: number[];
	// 											type: string;
	// 											w: number;
	// 										};
	// 								  }
	// 							>;
	// 						};
	// 					};
	// 					spoiler?: boolean;
	// 				};
	// 			};
	// 		};
	// 	};
	// }>;

	message: string;
	out: boolean;
	deleted: boolean;
	index: number;
	answers?: { tb: "message"; id: { String: string } }[];
	confidence?: number;
	is_answer?: boolean;
	is_question?: boolean;
};

// Constants for note positioning and sizing
const NOTE_OFFSET_X = 40;
const NOTE_OFFSET_Y = 40;
const NOTE_GRID_COLUMNS = 8;
const NOTE_GRID_ROWS = 12;
const NOTE_SPACING_X = 24;
const NOTE_SPACING_Y = 18;
const DEFAULT_NOTE_WIDTH = 240;
const DEFAULT_NOTE_HEIGHT = 120;
const ESTIMATED_ROW_HEIGHT = 120;
const ZOOM_SCALE_FACTOR = 0.0015;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;
const SEARCH_DEBOUNCE_MS = 300;

export function ChatView(props: { chat: Chat; close?: () => void }) {
	const renderCountRef = useRef(0);
	renderCountRef.current += 1;
	const headerRef = useRef<HTMLDivElement>(null);
	const [headerHeight, setHeaderHeight] = useState(0);

	useEffect(() => {
		if (headerRef.current) {
			setHeaderHeight(headerRef.current.offsetHeight);
		}
		const resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				setHeaderHeight(entry.target.clientHeight);
			}
		});
		if (headerRef.current) {
			resizeObserver.observe(headerRef.current);
		}
		return () => {
			if (headerRef.current) {
				resizeObserver.unobserve(headerRef.current);
			}
		};
	}, []);

	useEffect(() => {
		if (headerHeight > 0) {
			const updateSidebarPosition = () => {
				const sidebarContainer = document.querySelector(
					'[data-slot="sidebar-container"]'
				) as HTMLElement;
				if (sidebarContainer) {
					sidebarContainer.style.top = `${headerHeight}px`;
					sidebarContainer.style.height = `calc(100vh - ${headerHeight}px)`;
				}
			};
			updateSidebarPosition();
			// Use a small delay to ensure sidebar is rendered
			const timeoutId = setTimeout(updateSidebarPosition, 0);
			return () => clearTimeout(timeoutId);
		}
	}, [headerHeight]);
	// console.log(`🎨 ChatView render #${renderCountRef.current}`, {
	// 	chatId: props.chat.id,
	// });
	// 		query: `SELECT
	// type:
	// :string(id) as id,
	//         content[0].Telegram.Message.message AS message,
	//         content[0].Telegram.Message.out AS out,
	//         is_question,
	//         confidence,
	//         answers,
	//         is_answer
	//     FROM message
	//     WHERE
	//         chat_id =
	// type:
	// :record($chatId) AND
	//         (is_question = true or is_answer = true)`,
	// console.log(props.chat.id);
	const chatIdRangeStart = props.chat.id.split("⟨")[1].split("⟩")[0];
	const { data: messegasDictRaw } = useLiveQuery<"message", MessageRow>({
		table: "message",
		range: {
			start: chatIdRangeStart,
			end: `${chatIdRangeStart}:9`,
		},
		// range: null,
		queryKey: `chat_${props.chat.id}`,
	});
	// console.log("messegasDictRaw", messegasDictRaw);
	const messegas: Record<string, Message> = Object.fromEntries(
		Object.entries(messegasDictRaw ?? {})
			.filter(([, m]) => m !== undefined && m.is_question !== undefined)
			.map(([id, m]) => [
				id,
				{
					id,
					message: m.message,
					out: m.out,
					is_question: m.is_question ?? false,
					confidence: m.confidence ?? -1,
					answers:
						m.answers?.map((aid) =>
							new RecordId(aid.tb, aid.id.String).toString()
						) ?? [],
					is_answer: m.is_answer ?? false,
				},
			])
	);
	// console.log("dict", messegas);
	const vals = Object.values(messegas).filter(Boolean) as Message[];
	// console.log("vals", vals);
	const pairs = vals
		.filter((m) => m.is_question)
		.map((q) => {
			const ans = (q.answers ?? [])
				.map((aid) => messegas[aid])
				.filter((m): m is Message => !!m && m.is_answer);
			return { q, answers: ans };
		})
		.toSorted((a, b) => b.q.id.localeCompare(a.q.id));

	// Live board notes for this chat
	const { data: notesDict = {} } = useLiveQuery<
		"board_note",
		BoardNote & { id: { tb: "board_note"; id: { String: string } } }
	>({
		table: "board_note",
		range: null,
		queryKey: `board_note_${props.chat.id}`,
	});
	// console.log("notesDict", notesDict);
	const notes = Object.entries(notesDict ?? {}).map(([id, n]) => ({
		...n,
		id,
	}));
	// console.log("📋 [ChatView] notes count:", notes.length);
	// removed debug log

	// Search state
	const [searchQuery, setSearchQuery] = useState("");
	const [rawSearchResults, setRawSearchResults] = useState<
		Array<{ metadata: Record<string, unknown>; pageContent: string }>
	>([]);
	const [isSearching, setIsSearching] = useState(false);

	// Debounced search - only depends on query and chatId
	useEffect(() => {
		if (!searchQuery.trim()) {
			setRawSearchResults([]);
			return;
		}

		setIsSearching(true);
		const timer = setTimeout(async () => {
			try {
				const results = await searchMessages(searchQuery, chatIdRangeStart, 10);
				console.log("results", results);
				setRawSearchResults(
					results.map((doc) => ({
						metadata: doc.metadata,
						pageContent: doc.pageContent,
					}))
				);
			} catch (error) {
				console.error("Search error:", error);
				setRawSearchResults([]);
			} finally {
				setIsSearching(false);
			}
		}, SEARCH_DEBOUNCE_MS);

		return () => clearTimeout(timer);
	}, [searchQuery, chatIdRangeStart]);

	// Transform raw search results to QAPair format when messegas is available
	const searchResults = useMemo(() => {
		if (rawSearchResults.length === 0) {
			return [];
		}
		return rawSearchResults
			.map((doc) => {
				const messageId =
					typeof doc.metadata.id === "string"
						? doc.metadata.id
						: doc.pageContent;
				return messegas[messageId];
			})
			.filter((m): m is Message => !!m && m.is_question)
			.map((q) => {
				const ans = (q.answers ?? [])
					.map((aid) => messegas[aid])
					.filter((m): m is Message => !!m && m.is_answer);
				return { q, answers: ans };
			})
			.toSorted((a, b) => b.q.id.localeCompare(a.q.id));
	}, [rawSearchResults, messegas]);

	function getQuestionText(qid: string) {
		const m = (messegas as Record<string, Message | undefined>)[qid];
		return m?.message ?? "";
	}

	function getQuestion(qid: string): Message | undefined {
		return (messegas as Record<string, Message | undefined>)[qid];
	}

	function getAnswers(qid: string) {
		const dictM = messegas as Record<string, Message | undefined>;
		const q = dictM[qid];
		if (!q) {
			return [];
		}
		const ans = (q.answers ?? [])
			.map((aid) => dictM[aid])
			.filter((m): m is Message => !!m && m.is_answer);
		return ans;
	}

	async function updateNote(id: string, patch: Partial<BoardNote>) {
		console.log("updateNote", id, patch);
		await updateBoardNote(id, patch as BoardNotePatch);
	}

	// function safeId(s: string): string {
	//   return s.replace(/[^a-zA-Z0-9_-]/g, "_");
	// }

	async function handleAddToBoard(qid: string) {
		const maxZ = notes.length ? Math.max(...notes.map((n) => n?.z ?? 0)) : 0;
		await createBoardNote({
			question_id: qid,
			chat_id: props.chat.id,
			x: NOTE_OFFSET_X + (notes.length % NOTE_GRID_COLUMNS) * NOTE_SPACING_X,
			y: NOTE_OFFSET_Y + (notes.length % NOTE_GRID_ROWS) * NOTE_SPACING_Y,
			z: maxZ + 1,
			color: null,
			width: null,
			height: null,
		});
	}

	const parentRef = useRef<HTMLDivElement | null>(null);
	const rowVirtualizer = useVirtualizer({
		count: pairs.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => ESTIMATED_ROW_HEIGHT,
		overscan: 10,
		getItemKey: (index) => pairs[index]?.q.id ?? String(index),
		// allow dynamic row heights
		measureElement: (el) => el.getBoundingClientRect().height,
	});

	function renderSidebarContent() {
		if (searchQuery) {
			if (isSearching) {
				return (
					<div className="p-4 text-muted-foreground text-sm">Searching...</div>
				);
			}

			if (searchResults.length === 0) {
				return (
					<div className="p-4 text-muted-foreground text-sm">
						No results found.
					</div>
				);
			}

			return (
				<div>
					<div className="border-b bg-background px-4 py-2">
						<div className="font-medium text-muted-foreground text-xs">
							{searchResults.length} result
							{searchResults.length === 1 ? "" : "s"} found
						</div>
					</div>
					{searchResults.map((pair) => (
						<PairRow key={pair.q.id} onAdd={handleAddToBoard} pair={pair} />
					))}
				</div>
			);
		}

		if (pairs.length === 0) {
			return (
				<div className="p-6 text-muted-foreground text-sm">
					No questions found for this chat.
				</div>
			);
		}

		return (
			<div
				style={{
					height: rowVirtualizer.getTotalSize(),
					position: "relative",
					width: "100%",
				}}
			>
				{rowVirtualizer.getVirtualItems().map((vi) => {
					const pair = pairs[vi.index];
					return (
						<div
							className="absolute top-0 left-0 w-full"
							data-index={vi.index}
							key={vi.key}
							ref={rowVirtualizer.measureElement}
							style={{ transform: `translateY(${vi.start}px)` }}
						>
							<PairRow onAdd={handleAddToBoard} pair={pair} />
						</div>
					);
				})}
			</div>
		);
	}

	return (
		<SidebarProvider className="flex h-screen max-h-screen flex-col">
			<div
				className="fixed top-0 right-0 left-0 z-30 flex flex-col gap-2 border-b bg-background px-4 py-2"
				ref={headerRef}
			>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						{props.close ? (
							<Button onClick={props.close} size="sm" variant="outline">
								<ArrowLeft className="h-4 w-4" />
							</Button>
						) : null}
						<SidebarTrigger className="mr-2 ml-auto" />
					</div>
					<div className="text-muted-foreground text-xs">
						{pairs.length} Q/A {pairs.length === 1 ? "pair" : "pairs"}
					</div>
				</div>
				<div className="relative">
					<Search className="-translate-y-1/2 absolute top-1/2 left-2 h-4 w-4 text-muted-foreground" />
					<Input
						className="pl-8"
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search messages..."
						value={searchQuery}
					/>
				</div>
			</div>
			<div
				className="flex min-h-0 flex-1"
				style={{ paddingTop: `${headerHeight}px` }}
			>
				<Sidebar collapsible="offcanvas">
					<SidebarRail />
					<SidebarContent className="overflow-auto p-0" ref={parentRef}>
						{renderSidebarContent()}
					</SidebarContent>
				</Sidebar>
				<SidebarInset className="min-h-0 flex-1">
					<Board
						getAnswers={getAnswers}
						getQuestion={getQuestion}
						getQuestionText={getQuestionText}
						notes={notes}
						onUpdateNote={updateNote}
					/>
				</SidebarInset>
			</div>
		</SidebarProvider>
	);
}

function PairRow({
	pair,
	onAdd,
}: {
	pair: QAPair;
	onAdd: (qid: string) => void;
}) {
	const questionBgColor = pair.q.out
		? "bg-blue-100 border-blue-300"
		: "bg-green-100 border-green-300";
	const questionTextColor = pair.q.out ? "text-blue-900" : "text-green-900";

	return (
		<div className="border-b px-4 py-3">
			<div className="mb-1 flex items-center justify-between gap-3">
				<div className={`font-medium text-xs ${questionTextColor}`}>
					Q {pair.q.out ? "(Out)" : "(In)"}
				</div>
				<Button
					onClick={() => onAdd(pair.q.id)}
					size="sm"
					type="button"
					variant="secondary"
				>
					<Plus className="h-4 w-4" />
				</Button>
			</div>
			<div
				className={`mb-2 whitespace-pre-wrap rounded-md border px-3 py-2 ${questionBgColor} ${questionTextColor}`}
			>
				{pair.q.message}
			</div>
			<div className="space-y-2">
				{pair.answers.length > 0 ? (
					pair.answers.map((a) => {
						const answerBgColor = a.out
							? "bg-blue-50 border-blue-200"
							: "bg-green-50 border-green-200";
						const answerTextColor = a.out ? "text-blue-900" : "text-green-900";
						return (
							<div
								className={`rounded-md border px-3 py-2 ${answerBgColor}`}
								key={a.id}
							>
								<div className={`mb-1 font-medium text-xs ${answerTextColor}`}>
									A {a.out ? "(Out)" : "(In)"}
								</div>
								<div className={`whitespace-pre-wrap ${answerTextColor}`}>
									{a.message}
								</div>
							</div>
						);
					})
				) : (
					<div className="text-muted-foreground text-sm italic">No answers</div>
				)}
			</div>
		</div>
	);
}

function Board({
	notes,
	getQuestionText,
	getQuestion,
	getAnswers,
	onUpdateNote,
}: {
	notes: BoardNote[];
	getQuestionText: (qid: string) => string;
	getQuestion: (qid: string) => Message | undefined;
	getAnswers: (qid: string) => Message[];
	onUpdateNote: (id: string, patch: Partial<BoardNote>) => Promise<void>;
}) {
	const [scale, setScale] = useState(1);
	const [offset, setOffset] = useState({ x: 0, y: 0 });
	const panningRef = useRef(false);
	const lastRef = useRef({ x: 0, y: 0 });
	const containerRef = useRef<HTMLDivElement | null>(null);

	const maxZ = notes.reduce((m, n) => Math.max(m, n?.z ?? 0), 0);

	const bringToFront = async (id: string) => {
		await onUpdateNote(id, { z: maxZ + 1 });
	};

	const centerOnPoint = (wx: number, wy: number) => {
		const el = containerRef.current;
		if (!el) {
			return;
		}
		const { clientWidth, clientHeight } = el;
		setOffset({
			x: clientWidth / 2 - wx * scale,
			y: clientHeight / 2 - wy * scale,
		});
	};

	const centerBoard = () => {
		const el = containerRef.current;
		if (!el) {
			return;
		}
		if (notes.length === 0) {
			setScale(1);
			setOffset({ x: el.clientWidth / 2, y: el.clientHeight / 2 });
			return;
		}
		let minX = Number.POSITIVE_INFINITY,
			minY = Number.POSITIVE_INFINITY,
			maxX = Number.NEGATIVE_INFINITY,
			maxY = Number.NEGATIVE_INFINITY;
		for (const n of notes) {
			const w = n.width ?? DEFAULT_NOTE_WIDTH;
			const h = n.height ?? DEFAULT_NOTE_HEIGHT;
			minX = Math.min(minX, n.x);
			minY = Math.min(minY, n.y);
			maxX = Math.max(maxX, n.x + w);
			maxY = Math.max(maxY, n.y + h);
		}
		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;
		centerOnPoint(cx, cy);
	};

	const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
		if (e.ctrlKey || e.metaKey) {
			const delta = -e.deltaY;
			const factor = 1 + delta * ZOOM_SCALE_FACTOR;
			let next = scale * factor;
			next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));

			const rect = e.currentTarget.getBoundingClientRect();
			const mx = e.clientX - rect.left;
			const my = e.clientY - rect.top;

			// world coords under mouse before zoom
			const wx = (mx - offset.x) / scale;
			const wy = (my - offset.y) / scale;

			setScale(next);
			setOffset({
				x: mx - wx * next,
				y: my - wy * next,
			});
		} else {
			setOffset((prev) => ({ x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
		}
	};

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
		panningRef.current = true;
		lastRef.current = { x: e.clientX, y: e.clientY };
	};

	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!panningRef.current) {
			return;
		}
		const dx = e.clientX - lastRef.current.x;
		const dy = e.clientY - lastRef.current.y;
		lastRef.current = { x: e.clientX, y: e.clientY };
		setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
	};

	const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
		(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
		panningRef.current = false;
	};

	return (
		<div
			className="relative h-full w-full overflow-hidden bg-background"
			onWheel={onWheel}
			ref={containerRef}
		>
			<div className="absolute top-2 right-2 z-50 flex gap-2">
				<Button onClick={centerBoard} size="sm" type="button" variant="outline">
					<Target className="h-4 w-4" />
				</Button>
			</div>
			<div
				className="absolute inset-0 cursor-grab active:cursor-grabbing"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
			/>
			<div
				className="absolute inset-0"
				style={{
					transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
					transformOrigin: "0 0",
				}}
			>
				{notes
					.slice()
					.sort((a, b) => (a.z ?? 0) - (b.z ?? 0))
					.map((n) => (
						<StickyNote
							answers={getAnswers(n.question_id)}
							centerOn={centerOnPoint}
							key={n.id}
							note={n}
							onFocus={() => bringToFront(n.id)}
							onUpdateNote={onUpdateNote}
							question={getQuestion(n.question_id)}
							scale={scale}
							text={getQuestionText(n.question_id)}
						/>
					))}
			</div>
		</div>
	);
}

function StickyNote({
	note,
	text,
	question,
	answers,
	scale,
	onUpdateNote,
	onFocus,
	centerOn,
}: {
	note: BoardNote;
	text: string;
	question?: Message;
	answers: Message[];
	scale: number;
	onUpdateNote: (id: string, patch: Partial<BoardNote>) => Promise<void>;
	onFocus: () => void;
	centerOn: (wx: number, wy: number) => void;
}) {
	const [pos, setPos] = useState({ x: note.x, y: note.y });
	const draggingRef = useRef(false);
	const lastRef = useRef({ x: 0, y: 0 });
	const noteRef = useRef<HTMLDivElement | null>(null);

	// Sync external updates when not dragging
	useEffect(() => {
		if (!draggingRef.current) {
			setPos({ x: note.x, y: note.y });
		}
	}, [note.x, note.y]);

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
		draggingRef.current = true;
		lastRef.current = { x: e.clientX, y: e.clientY };
		onFocus();
	};

	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!draggingRef.current) {
			return;
		}
		const dxs = e.clientX - lastRef.current.x;
		const dys = e.clientY - lastRef.current.y;
		lastRef.current = { x: e.clientX, y: e.clientY };
		// Convert screen delta to world delta
		const dx = dxs / scale;
		const dy = dys / scale;
		setPos((p) => ({ x: p.x + dx, y: p.y + dy }));
	};

	const onPointerUp = async (e: React.PointerEvent<HTMLDivElement>) => {
		(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
		draggingRef.current = false;
		await onUpdateNote(note.id, { x: pos.x, y: pos.y });
	};

	const onCenterHere = () => {
		const el = noteRef.current;
		const w = el?.offsetWidth ?? note.width ?? DEFAULT_NOTE_WIDTH;
		const h = el?.offsetHeight ?? note.height ?? DEFAULT_NOTE_HEIGHT;
		centerOn(pos.x + w / 2, pos.y + h / 2);
	};

	const onDelete = async () => {
		await deleteBoardNote(note.id);
	};

	// Determine question color based on the question's 'out' property
	const questionOut = question?.out;
	let questionBgColor = "bg-yellow-100 ring-yellow-200";
	let questionTextColor = "text-yellow-900";
	let questionLabel = "";
	if (questionOut === true) {
		questionBgColor = "bg-blue-100 ring-blue-300";
		questionTextColor = "text-blue-900";
		questionLabel = "(Out)";
	} else if (questionOut === false) {
		questionBgColor = "bg-green-100 ring-green-300";
		questionTextColor = "text-green-900";
		questionLabel = "(In)";
	}

	return (
		<div
			className={`absolute select-none rounded-md p-2 shadow-md ring-1 ${questionBgColor} ${questionTextColor}`}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			ref={noteRef}
			style={{
				left: pos.x,
				top: pos.y,
				zIndex: note.z ?? 0,
				width: note.width ?? DEFAULT_NOTE_WIDTH,
			}}
		>
			<div className="mb-1 flex items-center justify-between gap-2">
				<div className={`font-medium text-[11px] ${questionTextColor}/80`}>
					Q {questionLabel}
				</div>
				<div className="flex items-center gap-1">
					<Button
						onClick={onCenterHere}
						size="sm"
						type="button"
						variant="outline"
					>
						<Target className="h-4 w-4" />
					</Button>
					<Button
						onClick={onDelete}
						size="sm"
						type="button"
						variant="destructive"
					>
						<Trash2 className="h-4 w-4" />
					</Button>
				</div>
			</div>
			<div className="whitespace-pre-wrap text-sm">
				{text || "(no question text)"}
			</div>
			{answers.length > 0 ? (
				<div className="mt-2 space-y-2">
					{answers.map((a) => {
						const answerBgColor = a.out
							? "bg-blue-50/80 border border-blue-200"
							: "bg-green-50/80 border border-green-200";
						const answerTextColor = a.out ? "text-blue-900" : "text-green-900";
						return (
							<div
								className={`rounded-md border px-2 py-1 text-sm ${answerBgColor}`}
								key={a.id}
							>
								<div className={`mb-1 font-medium text-xs ${answerTextColor}`}>
									A {a.out ? "(Out)" : "(In)"}
								</div>
								<div className={`whitespace-pre-wrap ${answerTextColor}`}>
									{a.message}
								</div>
							</div>
						);
					})}
				</div>
			) : null}
		</div>
	);
}
