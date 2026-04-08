import { useNavigate, useParams } from "@tanstack/react-router";
import { Users } from "lucide-react";
import type { Id } from "@/lib/convex";
import { cn } from "@/lib/utils";
import { ContactList } from "./contact-list";
import { ContactView } from "./contact-view";

export function ContactsPage(): React.ReactNode {
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const selectedContactId = (params.contactId ?? null) as Id<"contacts"> | null;

  const handleSelectContact = (contactId: Id<"contacts"> | null): void => {
    if (contactId) {
      navigate({
        to: "/contacts/$contactId",
        params: { contactId },
      });
    } else {
      navigate({ to: "/contacts" });
    }
  };

  return (
    <div className="flex h-full">
      <div
        className={cn(
          "h-full w-full shrink-0 border-border/50 border-r md:w-80 lg:w-96",
          selectedContactId ? "hidden md:block" : "block"
        )}
      >
        <ContactList
          onSelectContact={handleSelectContact}
          selectedContactId={selectedContactId}
        />
      </div>

      <div
        className={cn(
          "h-full flex-1",
          selectedContactId ? "block" : "hidden md:block"
        )}
      >
        {selectedContactId ? (
          <ContactView
            contactId={selectedContactId}
            onBack={() => handleSelectContact(null)}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center p-4 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/8">
              <Users className="h-7 w-7 text-primary/40" />
            </div>
            <h3 className="mt-5 font-display font-medium text-base">
              Select a contact
            </h3>
            <p className="mt-1.5 max-w-xs text-muted-foreground/70 text-sm">
              Choose a contact from the list to view their conversations
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
