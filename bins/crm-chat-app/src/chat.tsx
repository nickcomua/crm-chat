import { surrealql } from "@surrealdb/surrealdb";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowLeft, Plus, Target, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Sidebar,
	SidebarContent,
	SidebarInset,
	SidebarProvider,
	SidebarRail,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import type { Chat } from "./app";
import { useLiveQuery } from "./contexts/surreal-provider";
import * as boardNoteService from "./services/board-note-service";

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

export function ChatView(props: { chat: Chat; close?: () => void }) {
	const { data: messegas = {} } = useLiveQuery<Message>({
		query: surrealql`SELECT
            type::string(id) as id,
            content[0].Telegram.Message.message AS message,
            content[0].Telegram.Message.out AS out,
            is_question,
            confidence,
            answers,
            is_answer
        FROM message
        WHERE
            chat_id = type::record(${props.chat.id}) AND
            (is_question = true or is_answer = true)`,
		liveQuery: surrealql`LIVE SELECT
            type::string(id) as id,
            content[0].Telegram.Message.message AS message,
            content[0].Telegram.Message.out AS out,
            is_question,
            confidence,
            answers,
            is_answer
        FROM message
        WHERE
            chat_id = type::record(${props.chat.id}) AND
            (is_question = true or is_answer = true)`,
		queryKey: ["chat", props.chat.id],
	});

	const dict = messegas as Record<string, Message | undefined>;
	const vals = Object.values(dict).filter(Boolean) as Message[];
	const questions = vals.filter((m) => m.is_question);
	const built = questions.map((q) => {
		const ans = (q.answers ?? [])
			.map((aid) => dict[aid])
			.filter((m): m is Message => !!m && m.is_answer);
		return { q, answers: ans };
	});

	const pairs = built.toSorted((a, b) => b.q.id.localeCompare(a.q.id));

	// Live board notes for this chat
	const { data: notesDict = {} } = useLiveQuery<BoardNote>({
		query: surrealql`SELECT
            type::string(id) as id,
            question_id,
            x, y, z, color, width, height
        FROM boardnote
        WHERE chat_id = ${props.chat.id}`,
		liveQuery: surrealql`LIVE SELECT
            type::string(id) as id,
            question_id,
            x, y, z, color, width, height
        FROM boardnote
        WHERE chat_id = ${props.chat.id}`,
		queryKey: ["boardnote", props.chat.id],
	});
	const notes = Object.values(notesDict ?? {}).filter(Boolean) as BoardNote[];
	console.log("notes", notes);
	// removed debug log
	function getQuestionText(qid: string) {
		const m = (messegas as Record<string, Message | undefined>)[qid];
		return m?.message ?? "";
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
		await boardNoteService.updateBoardNote(id, patch as any);
	}

	// function safeId(s: string): string {
	//   return s.replace(/[^a-zA-Z0-9_-]/g, "_");
	// }

	async function handleAddToBoard(qid: string) {
		const maxZ = notes.length ? Math.max(...notes.map((n) => n?.z ?? 0)) : 0;
		await boardNoteService.createBoardNote({
			question_id: qid,
			chat_id: props.chat.id,
			x: 40 + (notes.length % 8) * 24,
			y: 40 + (notes.length % 12) * 18,
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
		estimateSize: () => 120,
		overscan: 10,
		getItemKey: (index) => pairs[index]?.q.id ?? String(index),
		// allow dynamic row heights
		measureElement: (el) => el.getBoundingClientRect().height,
	});

	return (
		<SidebarProvider className="flex h-screen max-h-screen flex-col">
			<div className="flex items-center justify-between border-b px-4 py-2">
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
			<div className="flex min-h-0 flex-1">
				<Sidebar collapsible="icon">
					<SidebarRail />
					<SidebarContent className="overflow-auto p-0" ref={parentRef}>
						{pairs.length === 0 ? (
							<div className="p-6 text-muted-foreground text-sm">
								No questions found for this chat.
							</div>
						) : (
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
						)}
					</SidebarContent>
				</Sidebar>
				<SidebarInset className="min-h-0 flex-1">
					<Board
						getAnswers={getAnswers}
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
	return (
		<div className="border-b px-4 py-3">
			<div className="mb-1 flex items-center justify-between gap-3">
				<div className="text-muted-foreground text-xs">Q</div>
				<Button
					onClick={() => onAdd(pair.q.id)}
					size="sm"
					type="button"
					variant="secondary"
				>
					<Plus className="h-4 w-4" />
				</Button>
			</div>
			<div className="mb-2 whitespace-pre-wrap">{pair.q.message}</div>
			<div className="space-y-2">
				{pair.answers.length > 0 ? (
					pair.answers.map((a) => (
						<div className="rounded-md bg-secondary/40 px-3 py-2" key={a.id}>
							<div className="whitespace-pre-wrap">{a.message}</div>
						</div>
					))
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
	getAnswers,
	onUpdateNote,
}: {
	notes: BoardNote[];
	getQuestionText: (qid: string) => string;
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
			const w = n.width ?? 240;
			const h = n.height ?? 120;
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
			const factor = 1 + delta * 0.0015;
			let next = scale * factor;
			next = Math.min(3, Math.max(0.3, next));

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
	answers,
	scale,
	onUpdateNote,
	onFocus,
	centerOn,
}: {
	note: BoardNote;
	text: string;
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
		const w = el?.offsetWidth ?? note.width ?? 240;
		const h = el?.offsetHeight ?? note.height ?? 120;
		centerOn(pos.x + w / 2, pos.y + h / 2);
	};

	const onDelete = async () => {
		await boardNoteService.deleteBoardNote(note.id);
	};

	return (
		<div
			className="absolute select-none rounded-md bg-yellow-100 p-2 text-black shadow-md ring-1 ring-yellow-200"
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			ref={noteRef}
			style={{
				left: pos.x,
				top: pos.y,
				zIndex: note.z ?? 0,
				width: note.width ?? 240,
			}}
		>
			<div className="mb-1 flex items-center justify-between gap-2">
				<div className="font-medium text-[11px] text-yellow-900/80">Q</div>
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
					{answers.map((a) => (
						<div
							className="rounded-md bg-yellow-50/80 px-2 py-1 text-sm"
							key={a.id}
						>
							{a.message}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
