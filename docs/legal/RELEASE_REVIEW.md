# Legal release review

Updated 23 October 2026 from the five revised files supplied by the release owner. Review statuses below are transcribed from the analysis workbook; they are not newly granted approvals.

| Document or material | Responsibility | Supplied review status |
| --- | --- | --- |
| Privacy Policy | Legal, with Privacy/Data Protection confirmation as required | Reviewed |
| Terms and Conditions | Legal | Reviewed |
| Apache License 2.0 / repository LICENSE file | Legal to confirm final implementation and scope | Reviewed in principle |
| Third-party licence notices and dependency inventory (NOTICE, SBOM or equivalent, where applicable) | Engineering to prepare; Legal to review licence compatibility and obligations | Review if required by the included components and distribution model |
| README, installation guide and developer documentation | Product/Engineering, with Legal review of relevant provisions | Only if they contain legal claims, licence terms, warranties, disclaimers, data-use representations or commitments |
| API documentation and integration instructions | Product/Engineering and Security, with Legal review of legal representations | Targeted review if they describe access rights, data handling, API usage restrictions, security commitments or paid services |
| Security disclosures, vulnerability reporting and support commitments | Security/Product, with Legal review of commitments and liability implications | If published or promised to users |
| Repository contents and release package | Engineering and Security, with Legal addressing identified ownership or licensing issues | Legal need not conduct the technical audit; confirmation is needed that no unauthorised third-party code, credentials, customer data or confidential material is included |

## Source mapping

- `02_Krutrim_Connect_P0_README_Legal_Sections_revised.docx`: README sections on Cloud Terms and Privacy, API keys, third-party tools, AI-generated output, and licensing. Engineering storage and transmission details were added from the implementation.
- `03_Krutrim_Connect_P0_License_Proposal_revised.docx`: standard Apache 2.0 LICENSE, NOTICE, package metadata, and LICENSE_SCOPE.md. Prior MIT notices are retained.
- `Krutrim Cloud_Krutrim Connect_Privacy Policy_revised_v1.docx`: PRIVACY_POLICY.md, with tracked insertions included and deletions excluded. Reviewer comments are recorded below, not published as operative clauses.
- `Krutrim Cloud_Krutrim Connect_Terms & Conditions_revised.docx`: TERMS_AND_CONDITIONS.md, with tracked insertions included and deletions excluded.
- `Krutrim Connect_Documents Analysis.xlsx`, Sheet1 B2:D10: review matrix above.

The policy transcriptions omit the website promotion/navigation/footer, preserve the remaining supplied wording, and add Markdown headings. Source DOCX/XLSX binaries, author metadata, comments and removed wording are not included in the public release payload.

## Confirmations still required

- The workbook marks Apache 2.0 as reviewed in principle. Confirm final scope, source ownership, compatibility and redistribution obligations before release. The local implementation follows the proposed licence; it does not establish clearance for third-party components.
- Privacy reviewer comment: confirm whether Krutrim collects resource consumption, usage volumes, system logs, diagnostics and feature usage; confirm the definition of Service Usage Data and its exclusion of Customer Data and Personal Data contained in Customer Data. A second comment says “Business to confirm” on the Privacy Queries paragraph covering cloudsupport@olakrutrim.com and the applicable response procedures and timelines.
- The Privacy source retains overlapping account-information paragraphs. The Terms source retains overlapping wording in “Use of Customer Data”, an “f you” typo in Eligibility, and cross-references to numbered clauses that need checking against final publication. These were preserved rather than changing legal meaning without a supplied resolution.
- The revised policy copies are not automatically effective website policies. Confirm the final wording, effective dates and publication owner; README links remain the applicable published Cloud policies.
- Refresh the dependency inventory/SBOM and inspect the actual bundled runtime and native-component notices for each target. A source-code licence does not replace those obligations.
- Establish the intended public vulnerability-reporting route and any support commitments; SECURITY.md currently describes the interim reporting process.

## Public release handoff

Destination: `ola-krutrim/krutrimconnect`. Initial public version: `0.1.0`.
Create a fresh public snapshot with its own history and tag; do not reuse or move the old repository's v0.1.0 tag. The old repository and internal branches remain separate.

The installer, updater, catalogue endpoint and public workflows are pinned to the new repository. npm publication is disabled in package.json; npm remains an internal build dependency and legacy upgrade compatibility is retained.

Existing internal 0.1.12 installations cannot upgrade to 0.1.0. Disconnect their harnesses, uninstall the old owned installation, install the public release, then reconnect. Do not bypass repository-ownership or downgrade checks.

Public CI uses GitHub-hosted runners. The draft workflow must run on the reviewed matching version tag, builds macOS arm64/x64 and Linux x64/glibc, and verifies each archive lifecycle. Publish only after the confirmations above and actual downloaded-asset verification are complete. Windows and Alpine are not supported.
