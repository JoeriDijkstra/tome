# Gaps found while writing packs

A running list of places where a pack had to work around the app, and the cleaner abstraction for each. The app may change: the goal is clean, system-agnostic building blocks, not fitting each system into today's app.

Status: **fixed** (changed in the app), **open** (workaround in place), **decided** (kept on purpose).

| # | Gap | Found in | Workaround | Clean abstraction | Status |
|---|---|---|---|---|---|
| 1 | A tab can't be hidden for characters it doesn't apply to | D&D Spells tab | — | `visible_when` on tabs | fixed |
| 2 | List rows have no right-aligned value (skill bonus, to-hit, quantity) | D&D skills, attacks, inventory | values in subtitles | `row.trailing` text | fixed |
| 3 | No way to keep only some elements of a list | equipped weapons, cantrips | — | `filter(list, pred)` | fixed |
| 4 | Text templates were capped at 4 000 characters, too short for long rules text | 3 SRD magic items | — | separate prose limit (50 000); each embedded formula keeps 4 000 | fixed |
| 5 | Choosers list every option with no search (476 items, 319 spells) | D&D add item / spells | — | searchable chooser | fixed |
| 6 | Each class resource must be named in the sheet layout, so an expansion's new resource never appears | D&D Actions tab | 13 hard-coded resource widgets | widget that lists every resource the character's entities provide | fixed |
| 7 | Entity ids are unique across all types, so the spell Shield and the item Shield collide | D&D SRD | generator suffixes the item id | ids unique per type; `entity()` takes a type when ambiguous | open |
| 8 | No list union / concatenation | background skills | one `push` per skill with a duplicate check | `concat` on lists, or `union(a, b)` | open |
| 9 | A resource's rest rule can't change with level (Bardic Inspiration returns on a short rest from level 5) | D&D bard | classes get `short_rest`/`long_rest` hooks that the rest actions call | conditional reset: `reset: [{ tag, when }]` | open |
| 10 | Resource ids are global, so two classes can't share "Channel Divinity" with different maximums | D&D cleric/paladin | separate ids (`channel_divinity`, `oath_channel`) | resource max as a modifier target, so several entities can contribute to one pool | open |
| 11 | Per-row computed values (attack bonus of each inventory weapon) live in UI templates | D&D attacks | formulas repeated in the Actions tab | derived values `each` over a list field | open |
| 12 | `{…}` in text can't hold an object literal | ability abbreviations | an `abilities` lookup table | none needed | decided |
| 13 | Hook keys are formulas, so a fixed key must be quoted (`"'any'"`) | race `create` hooks | quoting | hooks without a key, or a literal-key form | open |
| 14 | No dice rolling: HP gains, hit dice and damage are typed in | D&D | inputs with the average as default | optional roller later; deliberately out of scope for v1 | decided |
| 15 | Derived values assume one class (`main_class`) | D&D multiclass | single-class v1 | per-class caster level and combined slot table | open |
| 16 | Weapon attacks assume proficiency with every weapon | D&D attacks | always adds proficiency | structured class weapon proficiencies in the pack | open |
| 17 | Starting equipment isn't granted at creation | D&D | add items by hand | a creation step with equipment choices | open |
| 18 | "Score becomes X" can't be the final step: modifiers run set → max/min → add, so a racial bonus lands on top | Gauntlets of Ogre Power, Amulet of Health | `op: max` (right when no bonus to that score) | a final clamp phase after adds | open |
| 19 | A modifier aimed at a whole collection (`skills`, `saves`) can't see the entry it applies to | Jack of All Trades, Diamond Soul | one modifier per skill/save | bind `$k`/`$v` per entry for collection targets | open |
| 20 | Proficiency isn't a modifiable value; modifiers only change numbers | Diamond Soul, Slippery Mind | add `@prof_bonus` to the value | a modifier op that appends to a list, or proficiency as a numeric level (0, ½, 1, 2) taking the highest | open |
| 21 | No temporary state or roll modifiers (raging, advantage, crit range, minimum die result) | Rage, Reliable Talent | summaries only | active-state toggles modifiers can read; roll modifiers | open |
| 22 | Bonuses can't target one weapon group | Bracers of Archery, +N ammunition | prose | modifiers the attacks list evaluates per weapon (`$v` = weapon) | open |
| 23 | No "add, capped at N" | Belt of Dwarvenkind, Ioun stones | prose | same phase as #18 | open |
| 24 | Magic armor can't inherit a base armor's data and rules | Elven Chain, Mithral, Dragon Scale Mail | +N armor generated per base; named magic armor sets no AC | `data.base` with inherited data/modifiers | open |
| 25 | Option data can't drive another feature's text (ancestry → breath damage type) | Dragonborn | generic summary | structured option data (`data.damage_type`) read from `@options` | open |
| 26 | Long choosers render every row: 476 items took ~6 s to open | add item | — | page 50 rows with "Show more"; search covers all | fixed |
| 27 | Assign/allocation rows show raw keys (`Str`) | ability scores | — | `labels` on inputs | fixed |
| 28 | A chooser row can't show the option's full description before picking | fighting style, spells | summaries | info button opening the entity's description | open |
| 29 | In the wizard a dependent field (subrace) appears far below a long list that stays expanded after the pick | race step | — | collapse a long choice to its selection once picked | open |
| 30 | Each wizard number field is its own group, so six scores take six cards | manual ability entry | — | consecutive simple inputs share one group | open |
| 31 | Rarely-changed detail (14 condition toggles) crowds the main tab | D&D conditions | — | pages: unlisted tabs a stat opens with `open`, summarised by `join(...)` | fixed |
| 32 | The character list shows the system name, not the sheet's subtitle (race · class level) | character list | — | list rows use `sheet.header.subtitle` | open |
| 33 | Feat and option prerequisites can't be checked | XGE racial feats, invocations | text only | `prereq` formula field on `feat`/`option`; every chooser filters on `($v.data.prereq ?? true)` | fixed (pack) |
| 34 | Taking a feat or option can't grant anything further (spells, choices, +1) | XGE/TCE feats, Blessed Warrior | per-expansion patch of the ASI modal | the base runs the picked entity's `gain` hook after every feat/option choice | fixed (pack) |
| 35 | The creation abilities step `set`s the whole abilities object, wiping a +1 stored by an earlier step (a feat from the race step) | Custom Lineage, Variant Human | +1s as modifiers instead of stored adds | ability increases as modifiers everywhere, or the abilities step merging instead of replacing | open |
| 36 | Effects can't loop over a choice result | option `gain` hooks after multi-picks | one guarded `run_hook` per possible pick | a `for_each` effect (`{list, do}`) binding `$v` | open |
