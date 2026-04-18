import { useQuery } from "convex-helpers/react/cache";
import { useMutation } from "convex/react";
import { ChevronDown, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type Doc, type Id, onResultError } from "@/lib/convex";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./ui/popover";
import { Textarea } from "./ui/textarea";

type CustomFieldType = "text" | "number" | "date" | "email" | "phone" | "url";

const FIELD_TYPES: CustomFieldType[] = [
  "text",
  "number",
  "date",
  "email",
  "phone",
  "url",
];

interface CustomField {
  key: string;
  value: string;
  type?: CustomFieldType;
}

interface ContactCustomFieldsProps {
  contact: Doc<"contacts">;
}

function inputTypeFor(fieldType: CustomFieldType | undefined): string {
  switch (fieldType) {
    case "number":
      return "number";
    case "date":
      return "date";
    case "email":
      return "email";
    case "phone":
      return "tel";
    case "url":
      return "url";
    default:
      return "text";
  }
}

export function ContactCustomFields({
  contact,
}: ContactCustomFieldsProps): React.ReactNode {
  const contactId = contact._id as Id<"contacts">;
  const updateContact = useMutation(api.model.contacts.update);

  // Local editable copy of the fields — saves go through the explicit
  // "Save changes" button below the list.
  const [fields, setFields] = useState<CustomField[]>(() =>
    contact.customFields.map((f) => ({ ...f }))
  );
  const [dirty, setDirty] = useState(false);

  // Reset local state when the contact changes (e.g., switching contacts).
  useEffect(() => {
    setFields(contact.customFields.map((f) => ({ ...f })));
    setDirty(false);
  }, [contact._id, contact.customFields]);

  // Pull the full contact list (cached) so we can derive a key autocomplete.
  const allContacts = useQuery(api.model.contacts.list) as
    | Array<{ customFields: CustomField[] }>
    | undefined;

  const knownKeys = useMemo(() => {
    if (!allContacts) {
      return [];
    }
    const set = new Set<string>();
    for (const c of allContacts) {
      for (const f of c.customFields) {
        if (f.key.trim().length > 0) {
          set.add(f.key);
        }
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allContacts]);

  const updateField = (
    index: number,
    patch: Partial<CustomField>
  ): void => {
    setFields((prev) =>
      prev.map((f, i) => (i === index ? { ...f, ...patch } : f))
    );
    setDirty(true);
  };

  const addField = (): void => {
    setFields((prev) => [...prev, { key: "", value: "", type: "text" }]);
    setDirty(true);
  };

  const removeField = (index: number): void => {
    setFields((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };

  const saveChanges = (): void => {
    // Drop empty rows before saving.
    const cleaned = fields
      .filter((f) => f.key.trim().length > 0)
      .map((f) => ({
        key: f.key.trim(),
        value: f.value,
        type: f.type,
      }));
    updateContact({ contactId, customFields: cleaned }).then((res) => {
      onResultError(res);
      setDirty(false);
    });
  };

  const revertChanges = (): void => {
    setFields(contact.customFields.map((f) => ({ ...f })));
    setDirty(false);
  };

  return (
    <section className="pt-4">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="font-display font-medium text-sm">Custom fields</h3>
        <Button
          aria-label="Add custom field"
          className="h-7 gap-1 px-2 text-[12px]"
          onClick={addField}
          size="sm"
          variant="outline"
        >
          <Plus className="h-3 w-3" />
          Add field
        </Button>
      </header>

      {fields.length === 0 ? (
        <p className="py-3 text-muted-foreground/70 text-xs">
          No custom fields yet. Click &ldquo;Add field&rdquo; to create one.
        </p>
      ) : (
        <div className="space-y-2">
          {fields.map((field, index) => {
            const fieldType = field.type ?? "text";
            return (
              <div
                className="flex items-start gap-1.5"
                // biome-ignore lint/suspicious/noArrayIndexKey: stable during edit session
                key={index}
              >
                <div className="flex-1 space-y-1">
                  <div className="flex gap-1.5">
                    <Popover>
                      <PopoverTrigger asChild>
                        <Input
                          aria-label="Field key"
                          className="h-7 flex-1 text-[12px]"
                          onChange={(e) =>
                            updateField(index, { key: e.target.value })
                          }
                          placeholder="Key (e.g. email)"
                          // Override Radix PopoverTrigger's default type="button"
                          // so this remains a typable text input (users filter
                          // the suggestion popover by typing into it).
                          type="text"
                          value={field.key}
                        />
                      </PopoverTrigger>
                      {knownKeys.length > 0 && field.key.length > 0 && (
                        <PopoverContent
                          align="start"
                          className="max-h-48 w-56 overflow-y-auto p-1"
                        >
                          {knownKeys
                            .filter((k) =>
                              k
                                .toLowerCase()
                                .includes(field.key.toLowerCase())
                            )
                            .slice(0, 10)
                            .map((k) => (
                              <button
                                className="w-full rounded-sm px-2 py-1 text-left text-xs hover:bg-accent"
                                key={k}
                                onClick={() => updateField(index, { key: k })}
                                type="button"
                              >
                                {k}
                              </button>
                            ))}
                        </PopoverContent>
                      )}
                    </Popover>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          aria-label="Field type"
                          className="h-7 gap-1 px-2 text-[11px]"
                          size="sm"
                          variant="outline"
                        >
                          {fieldType}
                          <ChevronDown className="h-3 w-3" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {FIELD_TYPES.map((t) => (
                          <DropdownMenuItem
                            key={t}
                            onClick={() => updateField(index, { type: t })}
                          >
                            {t}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {fieldType === "text" ? (
                    <Textarea
                      aria-label="Field value"
                      className="min-h-[4rem] text-[12px]"
                      onChange={(e) =>
                        updateField(index, { value: e.target.value })
                      }
                      placeholder="Value"
                      value={field.value}
                    />
                  ) : (
                    <Input
                      aria-label="Field value"
                      className="h-7 text-[12px]"
                      onChange={(e) =>
                        updateField(index, { value: e.target.value })
                      }
                      placeholder="Value"
                      type={inputTypeFor(fieldType)}
                      value={field.value}
                    />
                  )}
                </div>
                <Button
                  aria-label="Remove field"
                  className="h-7 w-7 shrink-0"
                  onClick={() => removeField(index)}
                  size="icon"
                  variant="ghost"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {dirty && (
        <div className="mt-3 flex justify-end gap-2">
          <Button onClick={revertChanges} size="sm" variant="ghost">
            Revert
          </Button>
          <Button onClick={saveChanges} size="sm">
            Save changes
          </Button>
        </div>
      )}
    </section>
  );
}
