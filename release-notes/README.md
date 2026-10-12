# Release notes input

This directory holds the reviewed notes input for one product tag.

The tag workflow reads `release-notes/<tag>.md` before image promotion.

When that file is missing or malformed, the workflow fails before it publishes images or the GitHub Release.

## File format

Name the file with the exact tag, such as `release-notes/v0.1.0-rc.4.md`.

The file has exactly these two level-2 headings, in this order, and each heading is that exact line.

Each heading has a non-empty body.

Another level-2 heading, a repeated heading, or an empty section makes the file malformed.

The only level-2 headings are the exact lines `## Changes since the previous candidate` and `## Known issues`, in that order.

A level-1 or level-2 heading in any other form is rejected. That form is zero to three leading spaces, then one or two `#`, then a space, a tab, or the end of the line.

A setext underline is rejected. That form is zero to three leading spaces and then only `=` or only `-`.

A fence opener is rejected. That form is zero to three leading spaces and then three or more backticks or tildes.

A level-3 or deeper ATX heading inside a section stays allowed.

## Changes since the previous candidate

Write what changed since the previous candidate.

## Known issues

Write the known issues for this tag.

The workflow copies both sections into the GitHub Release notes unchanged.
