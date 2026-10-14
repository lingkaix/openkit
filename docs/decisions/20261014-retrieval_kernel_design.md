---
status: Accepted
date: "2026-10-14"
decider: Engineer
---
# Retrieval Kernel Design

## Decision

Use one domain-free Retrieval Kernel, written in Rust with Tantivy, with source adapters at the edge. Start with lexical retrieval and Chinese and Japanese word segmentation. Multimodal vector retrieval follows; pi-ai embeddings wait for that phase. Optical character recognition (OCR) comes last, only where multimodal retrieval works very badly.

Phase 1 indexes directly readable text. Only files that are not easy to read or index directly need a sidecar. Later content processing and multimodal retrieval follow the fragment pattern: representation, preview, source, and locator.

The engineer accepted [OpenKit Retrieval Kernel](../specs/20261014-retrieval_kernel.md) after two independent Consultant reviews. That specification owns the design and acceptance predicates.

## Reason

Users need one retrieval mechanism over conversations, Knowledge, Workspace data, and Artifacts and uploads. The engineer chose the simplest implementation that provides basic functions. The same-day refinement avoids generating another file for text that readers and the index can already handle directly.

Source: change record 202610140256550000-v0_1_0_core_experience, Engineer Rulings 3, 6, 7 with its same-day refinement, and 8. All statements below were given on 2026-10-14. Each English translation is copied from that source.

### Ruling 3: Unified Retrieval

Verbatim:

> 检索。你的设计的方向是正确的，就按这个去做。 注意，我们的设计方向，向量检索的话，是多模态的向量检索，这一点请参照zvec-grep and https://github.com/Tencent/WeKnora。 OCR反倒是比多模态向量更靠后的部分，仅使用在多模态检索效果十分差的特定场景之下。

Translation:

> Retrieval: your design direction is right; do it that way. Note that our direction for vector retrieval is multimodal vector retrieval; refer to zvec-grep and Tencent WeKnora. OCR comes after multimodal vectors and is used only in specific cases where multimodal retrieval works very badly.

### Ruling 6: Simplest Implementation First

Verbatim:

> 我同意你的这个搜索引擎的设计。我们先做一个最简单的实现，能够把最基本的功能提供给客户。至于 Pi AI 没有 embedding 接口的问题，等到我们实现多模态检索的时候，再来处理。

Translation:

> I agree with your retrieval engine design. We first build the simplest implementation that gives customers the most basic functions. The problem that pi-ai has no embedding interface waits until we implement multimodal retrieval.

### Ruling 7: Text First And Sidecars

Verbatim:

> 选项 A, 事实上，我认为其他类型的文件应该建立一个 Markdown 格式的索引文件或者 metadata 文件(json 格式?) 来进行快速的检索。将来我们会有处理 PDF 和 Office 文件的功能，但是如果是二进制文件呢？因此，第一，我们现在先不考虑特定文件类型的具体处理方式(对于常用的文件类型，将来我们会有)。第二， 从刚刚我提到这个角度来说，我们也需要一个更 general 的为所有类型的文件与数据建立快速索引的机制。

Translation:

> Option A. In fact, I think other file types should get a Markdown index file or a metadata file (JSON?) for fast retrieval. Later we will have functions that process PDF and Office files, but what about binary files? So, first, we do not now consider type-specific processing (for common file types we will have it later). Second, from the angle I just named, we also need a more general mechanism that builds a fast index for files and data of every type.

Same-day refinement:

Verbatim:

> 我觉得不需要每一个文件都生成一个 .md 文件，比如像纯文本文件或者 Markdown 文件就不需要，因为索引能够直接处理，也非常容易直接读取。我认为只有那些不太容易直接读取和索引的文件需要一个sidecar文件，能让我们的检索引擎快速的捕捉到里面的具体内容。比如你看一下这份报告里，这个所阐述的 indexed 这个软件的做法。另外，对于我们的将来的多模态检索，我们也参照其中的模式。

Translation:

> I do not think every file needs a generated .md file; plain text and Markdown files do not, because the index handles them directly and they are easy to read directly. Only files that are not easy to read and index directly need a sidecar file that lets our retrieval engine capture their content quickly. See how the Indexed software described in this report does it. Our future multimodal retrieval also follows that pattern.

Option A was to search only UTF-8 text already stored by the sources in phase 1. Other bytes are not text-searchable; PDF, Office, and archive extraction wait for later work. The Indexed report referenced in the refinement described fragments with a representation, preview, source link, and locator, such as a timestamp. The refined ruling governs which files receive sidecars.

### Ruling 8: Specification Acceptance

Verbatim:

> 我接受这份 spec 文档。

Translation:

> I accept this specification.

## Rejected Alternatives

- A generated sidecar for every file: readable text and Markdown can be indexed and read directly. The engineer explicitly rejected the extra file in ruling 7's refinement.
- Type-specific PDF, Office, or archive extraction in phase 1: the engineer chose text already available from the sources. Common format processors wait for later work.
- Multimodal vectors before the basic lexical implementation, or OCR before multimodal vectors: rulings 3 and 6 set the order. OCR is limited to specific measured failures of multimodal retrieval.
- Requiring a pi-ai embedding interface before phase 1: ruling 6 defers that problem until multimodal retrieval.
- Separate search engines for each source or execution face: the accepted specification uses one implementation with adapters. Source rules stay at the edge.

## Revisit When

- A measured retrieval failure defeats the lexical-first order.
- The basic implementation cannot serve a named source or query.
- A common file type needs type-specific extraction.

## Affected Owners

- [OpenKit Retrieval Kernel](../specs/20261014-retrieval_kernel.md) owns the accepted mechanism and identifies the required source, storage, and deployment owner amendments.
