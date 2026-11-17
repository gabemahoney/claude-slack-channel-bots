# Native inverted attachment head

`trial2.json` retains the 13 UUID-bearing receipt, attachment, assistant and
tool-result records from Bug b.yjf's `inverted-head-trial2-evidence.log`
(AC11 case_01, job b, trial 2, Claude Code 2.1.296). UUIDs, parent UUIDs,
offsets, timestamps, attachment kinds and response messages are captured values.
The withheld receipt text is replaced with `case_01 stand-in prompt`.
Diagnostic projection fields, empty objects, attachment placeholder messages,
untimed metadata and post-completion bookkeeping are omitted.

The instructions attachment at offset 271 points to skill_listing at 21704;
the receipt is at 7608. The normal-layout control moves the same four head
attachments after skill_listing, preserving their captured clocks and links.
The tests synthesize only the durable journal and prompt stand-in; this is
offline oracle coverage and establishes no live model acceptance.
