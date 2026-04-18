import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex-helpers/react/cache";
import { useMutation, usePaginatedQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { api, type Id, onResultError } from "@/lib/convex";
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

interface ChatInfo {
  chatId: string;
  chatType: "Dialog" | "Group";
  pinnedName?: string;
}

interface AttachDialogToContactProps {
  chat: ChatInfo;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

interface ContactListRow {
  _id: Id<"contacts">;
  displayName: string;
}

export function AttachDialogToContactDialog({
  chat,
  onOpenChange,
  open,
}: AttachDialogToContactProps): React.ReactNode {
  const navigate = useNavigate();
  const contacts = useQuery(api.model.contacts.list) as
    | ContactListRow[]
    | undefined;

  const [search, setSearch] = useState("");
  const [selectedContactId, setSelectedContactId] =
    useState<Id<"contacts"> | null>(null);
  const [pickingSender, setPickingSender] = useState(false);
  const [senderId, setSenderId] = useState<string | null>(null);
  const [reassignNeeded, setReassignNeeded] = useState(false);
  const [successContactId, setSuccessContactId] =
    useState<Id<"contacts"> | null>(null);

  // Reset when re-opened.
  useEffect(() => {
    if (open) {
      setSearch("");
      setSelectedContactId(null);
      setPickingSender(false);
      setSenderId(null);
      setReassignNeeded(false);
      setSuccessContactId(null);
    }
  }, [open]);

  const linkSender = useMutation(api.model.contacts.linkSender);

  // For Dialog chats, auto-resolve.
  const defaultSender = useQuery(
    api.model.contacts.resolveDefaultSenderId,
    open && chat.chatType === "Dialog" ? { chatId: chat.chatId } : "skip"
  ) as string | null | undefined;

  useEffect(() => {
    if (chat.chatType === "Dialog" && typeof defaultSender === "string") {
      setSenderId(defaultSender);
    }
  }, [chat.chatType, defaultSender]);

  // For Group chats, pull recent senders.
  const { results: groupMessages } = usePaginatedQuery(
    api.model.messages.listByChat,
    open && chat.chatType === "Group" && pickingSender
      ? { chatId: chat.chatId }
      : "skip",
    { initialNumItems: 100 }
  );

  const groupSenders = useMemo(() => {
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
  }, [groupMessages]);

  const filteredContacts = useMemo(() => {
    if (!contacts) {
      return [];
    }
    const q = search.trim().toLowerCase();
    if (q.length === 0) {
      return contacts;
    }
    return contacts.filter((c) => c.displayName.toLowerCase().includes(q));
  }, [contacts, search]);

  const attemptLink = (
    contactId: Id<"contacts">,
    pickedSenderId: string | null,
    reassign = false
  ): void => {
    if (pickedSenderId === null) {
      return;
    }
    linkSender({
      contactId,
      chatId: chat.chatId,
      senderId: pickedSenderId,
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
        setSuccessContactId(contactId);
      }
    });
  };

  const handleSelectContact = (contactId: Id<"contacts">): void => {
    setSelectedContactId(contactId);
    if (chat.chatType === "Dialog") {
      if (senderId !== null) {
        attemptLink(contactId, senderId, false);
      }
      return;
    }
    // Group chat: prompt for sender.
    setPickingSender(true);
  };

  const handlePickSender = (picked: string): void => {
    setSenderId(picked);
    if (selectedContactId) {
      // Pass `picked` directly — `senderId` state hasn't flushed yet, so
      // relying on it here would call linkSender with senderId=null and
      // the mutation would silently no-op (causing the sender-picker flow
      // to hang with no success UI).
      attemptLink(selectedContactId, picked, false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Attach dialog to contact</DialogTitle>
          <DialogDescription>
            Add this conversation to an existing contact.
          </DialogDescription>
        </DialogHeader>

        {successContactId ? (
          <div className="space-y-3">
            <p className="text-sm">Dialog linked successfully.</p>
            <DialogFooter>
              <Button
                onClick={() => onOpenChange(false)}
                variant="ghost"
              >
                Close
              </Button>
              <Button
                onClick={() => {
                  onOpenChange(false);
                  navigate({
                    to: "/contacts/$contactId",
                    params: { contactId: successContactId },
                  });
                }}
              >
                Open contact
              </Button>
            </DialogFooter>
          </div>
        ) : pickingSender ? (
          <div className="space-y-2">
            <p className="text-xs">Pick the sender to link:</p>
            <div className="rounded-md border border-border/60">
              <Command>
                <CommandInput placeholder="Search senders…" />
                <CommandList className="max-h-64">
                  <CommandEmpty>No senders found.</CommandEmpty>
                  <CommandGroup>
                    {groupSenders.map((s) => (
                      <CommandItem
                        key={s.senderId}
                        onSelect={() => handlePickSender(s.senderId)}
                        value={s.senderId}
                      >
                        <div className="flex w-full items-center justify-between gap-2">
                          <span>{s.senderId.slice(0, 24)}</span>
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
          </div>
        ) : (
          <div className="rounded-md border border-border/60">
            <Command>
              <CommandInput
                onValueChange={setSearch}
                placeholder="Search contacts…"
                value={search}
              />
              <CommandList className="max-h-64">
                <CommandEmpty>No contacts found.</CommandEmpty>
                <CommandGroup>
                  {filteredContacts.map((c) => (
                    <CommandItem
                      key={c._id}
                      onSelect={() => handleSelectContact(c._id)}
                      value={c.displayName}
                    >
                      {c.displayName}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </div>
        )}

        {reassignNeeded && selectedContactId && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
            This sender is already linked to another contact. Reassigning will
            move the link.
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
                  attemptLink(selectedContactId, senderId, true);
                }}
                size="sm"
              >
                Reassign
              </Button>
            </div>
          </div>
        )}

        {!successContactId && (
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} variant="ghost">
              Cancel
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
