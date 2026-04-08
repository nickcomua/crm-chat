import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex-helpers/react/cache";
import { useMutation, usePaginatedQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { api, onResultError } from "@/lib/convex";
import { getChatDisplayName } from "@/lib/utils";
import { Button } from "./ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

interface ChatInfo {
  chatId: string;
  chatType: "Dialog" | "Group";
  pinnedName?: string;
}

interface CreateContactDialogProps {
  chat: ChatInfo;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export function CreateContactDialog({
  chat,
  onOpenChange,
  open,
}: CreateContactDialogProps): React.ReactNode {
  const navigate = useNavigate();
  const initialName = getChatDisplayName(chat);

  const [displayName, setDisplayName] = useState(initialName);
  const [notes, setNotes] = useState("");
  const [senderId, setSenderId] = useState<string | null>(null);
  const [reassignNeeded, setReassignNeeded] = useState(false);

  // Reset form when re-opened.
  useEffect(() => {
    if (open) {
      setDisplayName(getChatDisplayName(chat));
      setNotes("");
      setSenderId(null);
      setReassignNeeded(false);
    }
  }, [open, chat]);

  const createContact = useMutation(api.model.contacts.create);

  // For Dialog chats, auto-resolve the sender.
  const defaultSender = useQuery(
    api.model.contacts.resolveDefaultSenderId,
    open && chat.chatType === "Dialog" ? { chatId: chat.chatId } : "skip"
  ) as string | null | undefined;

  useEffect(() => {
    if (chat.chatType === "Dialog" && typeof defaultSender === "string") {
      setSenderId(defaultSender);
    }
  }, [chat.chatType, defaultSender]);

  // For Group chats, pull recent messages to power the sender picker.
  const { results: groupMessages } = usePaginatedQuery(
    api.model.messages.listByChat,
    open && chat.chatType === "Group" ? { chatId: chat.chatId } : "skip",
    { initialNumItems: 100 }
  );

  const groupSenders = useMemo(() => {
    if (chat.chatType !== "Group") {
      return [];
    }
    const map = new Map<
      string,
      { senderId: string; count: number; lastSeen: number }
    >();
    for (const m of groupMessages as Array<{
      senderId: string;
      timestamp: number;
    }>) {
      if (!m.senderId) {
        continue;
      }
      const existing = map.get(m.senderId);
      if (existing) {
        existing.count += 1;
        if (m.timestamp > existing.lastSeen) {
          existing.lastSeen = m.timestamp;
        }
      } else {
        map.set(m.senderId, {
          senderId: m.senderId,
          count: 1,
          lastSeen: m.timestamp,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.lastSeen - a.lastSeen);
  }, [chat.chatType, groupMessages]);

  const canSubmit =
    displayName.trim().length > 0 && senderId !== null && senderId.length > 0;

  const submit = (reassign = false): void => {
    if (!canSubmit || senderId === null) {
      return;
    }
    createContact({
      displayName: displayName.trim(),
      notes: notes.trim().length > 0 ? notes.trim() : undefined,
      initialLink: { chatId: chat.chatId, senderId },
      reassign,
    }).then((res) => {
      if (
        res &&
        typeof res === "object" &&
        "Err" in res &&
        res.Err === "Sender already linked to another contact"
      ) {
        setReassignNeeded(true);
        return;
      }
      onResultError(res);
      if (res && typeof res === "object" && "Ok" in res) {
        const ok = res.Ok as { contactId: string };
        onOpenChange(false);
        navigate({
          to: "/contacts/$contactId",
          params: { contactId: ok.contactId },
        });
      }
    });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create contact from dialog</DialogTitle>
          <DialogDescription>
            Promote this conversation into a first-class CRM contact.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label className="font-medium text-xs" htmlFor="contact-name">
              Display name
            </label>
            <Input
              id="contact-name"
              onChange={(e) => setDisplayName(e.target.value)}
              value={displayName}
            />
          </div>

          <div className="space-y-1">
            <label className="font-medium text-xs" htmlFor="contact-notes">
              Notes
            </label>
            <Textarea
              id="contact-notes"
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes about this contact"
              value={notes}
            />
          </div>

          <div className="space-y-1">
            <p className="font-medium text-xs">Link this dialog</p>
            {chat.chatType === "Dialog" ? (
              <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs">
                {senderId ? (
                  <>
                    Will link this chat via sender{" "}
                    <code className="font-mono text-[11px]">
                      {senderId.slice(0, 16)}
                    </code>{" "}
                    (auto-detected).
                  </>
                ) : defaultSender === undefined ? (
                  "Detecting sender…"
                ) : (
                  <span className="text-amber-600 dark:text-amber-400">
                    Could not auto-detect the other party&apos;s sender. The
                    chat may have no incoming messages yet.
                  </span>
                )}
              </div>
            ) : (
              <div className="rounded-md border border-border/60">
                <Command>
                  <CommandInput placeholder="Pick a sender…" />
                  <CommandList className="max-h-48">
                    <CommandEmpty>No senders found.</CommandEmpty>
                    <CommandGroup>
                      {groupSenders.map((s) => (
                        <CommandItem
                          key={s.senderId}
                          onSelect={() => setSenderId(s.senderId)}
                          value={s.senderId}
                        >
                          <div className="flex w-full items-center justify-between gap-2">
                            <span
                              className={
                                senderId === s.senderId
                                  ? "font-medium"
                                  : undefined
                              }
                            >
                              {s.senderId.slice(0, 24)}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {s.count} msg
                            </span>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </div>
            )}
          </div>

          {reassignNeeded && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
              This sender is already linked to another contact. Reassigning
              will move the link to the new contact.
              <div className="mt-2 flex gap-2">
                <Button
                  onClick={() => setReassignNeeded(false)}
                  size="sm"
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    setReassignNeeded(false);
                    submit(true);
                  }}
                  size="sm"
                >
                  Reassign
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="ghost">
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => submit(false)}>
            Create contact
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
