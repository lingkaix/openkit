# Interface Unification Proposal

This proposal preserves why the interface unification was chosen, the scheme the engineer ruled on, the alternatives it rejected, the decisive evidence, and the material Consultant objections with their resolutions. It has no design authority of its own. The accepted decisions are listed in [plan.md](plan.md), and lasting design moves into the Core and specification owners the plan names. It condenses the uncommitted exploration in `temp/interface-unification/`: the proposal at revision 2, its superseded revision 1, the research reports R1 to R4, and the Consultant reports C1 and C2.

## 1. Why This Work Exists

The agent communication redesign settled how NanoCore and workers talk. The engineer then asked how to unify the interfaces between users and agents, between agents and system functions, and between agents, from first principles. The premise is that an agent in its loop does two things, model interaction and tool use, so the tools it is given are the interface that matters, and the question is whether agent-native tool definitions and calls can serve as the system's interface primitive.

Research found the principle already in Foundation and the implementation far from it:
- Operations are described in several parallel places that drift: 223 App API operations, 249 authorization entries, 245 CLI remote methods, 247 CLI catalog entries, and 15 Kernel and UI worker descriptors. They are different sets, not copies of one list.
- The internal agents mostly do not use tools. The ordinary Assistant calls the provider with no tools although its specification names 24.
- There is no proposal with a note. The approval response is identity plus granted or denied, and the ordinary Assistant launches Tasks without a proposal.
- There is no agent messaging, inbox, or operational Goal wake, and ordinary Chat model history keeps only completed user and assistant messages, so an Item recorded on an agent's Thread is not seen by that agent.
- Workers have no mid-run knowledge tool and nothing captures knowledge automatically.
- A per-user bearer token authenticates as the human user, including for approval responses.
- The removed user-facing MCP was a local stdio server that listed 93 tools eagerly and duplicated the Skill's guidance; those were the reasons for its removal, not properties of remote MCP.
- The current MCP revision and the Skills Over MCP extension exist, and the major agent clients have remote HTTP MCP with some authentication form, but live Skills loading was not verified in any of them.

## 2. The Scheme

- **Operation.** An operation has an intent-level name, a description written for an agent, input and output schemas, and its effect. HTTP routes, MCP tools, internal tools, and UI controls are projections of it.
- **Actor and grant.** The same operation can arrive from a person, an external agent, an internal role, or a worker, and the authorization owner decides from the actor's grant whether it runs. The surface adds nothing.
- **Facts are read, judgment is asked.** Anything Core owns is read through read operations by whoever needs it. A message to another agent is for its judgment or an instruction.
- **A Thread is an agent's address.** Instructions and questions go to an agent's Thread as input. Changes to facts are not copied into Threads; agents reread current state on their next admitted Turn.
- **One proposal path where one is asked for.** Only an agent-raised Task in conversation becomes a proposal with an approve-or-reject note. Artifact Review, Goal Review, Knowledge Proposal, and administration confirmation keep their owners.
- **Remote MCP.** NanoCore serves the operation catalog at the instance URL through search, describe, and one call, with workflow guidance in server instructions and a guide call. Internal agents call command implementations natively, not through the MCP endpoint.

The staged plan was: a connection probe, owner amendments, the endpoint and the Assistant tool loop, a guidance probe before retiring the Skill and CLI, knowledge, then the Goal redesign.

## 3. Alternatives Rejected

- **Wait for MCP progressive loading before switching.** Rejected: search, describe, and call keep the context cost low now, and the engineer chose plain fallbacks for features clients lack.
- **A registry, message bus, generic approval entity, inbox, or universal resource object.** Rejected by both Consultants and the engineer: the existing owners and the operation primitive carry the needs.
- **A human-reserved mark on operations, or refusing every token actor for reserved decisions** (revision 1). Rejected by C2: a per-user token is the human user, so refusing tokens would also refuse the person using the CLI and would not stop an agent holding the user's token. Reserved decisions are grants.
- **Changes by others recorded as Items on the owning agent's Thread** (revision 1). Rejected by C2: model history drops such Items and no Turn reads them; agents reread state instead.
- **Effect-split call tools.** Rejected by C2 in favor of one call until a named client's approval interface fails on it.
- **One decision shape for every proposal kind.** Narrowed to the Task proposal.
- **D1 option (b), a non-human external actor with its own credential that cannot answer approvals.** Not chosen now. The engineer ruled that the external agent acting on the user's token is the user, that approval stays open to it with instructions to ask the user, and that independent agent identities are the future direction through the Policy Kernel.
- **Collapsing all registries as a separate program** (revision 1). C2 removed it as unjustified; the engineer then asked for the definitions to be unified as far as possible within this redesign, so the unification returns as a goal of the work rather than a separate program, with its design still to be presented.

## 4. Material Consultant Objections

C1 (clean-room, Pi) independently reached the same four ingredients: operation, actor and grant, Thread, and decision. C2 (grounded, Grok) corrected revision 1's actor model, removed the machinery listed above, required the approval note to enter the Task's admitted input rather than sit beside it, and narrowed the first proof to a connection probe with a separate guidance probe before retirement. C2's revision 2 check tightened the actor bullet, D1, the note rule, and two figures. All C2 objections were accepted.

## 5. Decisive Evidence And Remaining Uncertainty

The authorization facts (token as user, approval as a workspace operation), the internal-agent tool gap, and the model-history behavior were read from code with file and line citations in the uncommitted reports. The connection probe ran Claude Code against an uncommitted endpoint; a rerun with an ordinary user token and a second client was in progress when the engineer ruled. The single-definition architecture is unresolved and goes to the engineer as architecture.
