# Carrier Plans (Fictional)

Three individual health insurance plans for this challenge. All figures are in **AED, annual**. These are invented for the exercise — not real products.

Machine-readable versions of this data are in `hackathon_data.json`.

| Attribute | **Essential (Plan A)** | **Balanced (Plan B)** | **Comprehensive (Plan C)** |
|---|---|---|---|
| **Annual premium** | AED 4,200 | AED 8,900 | AED 16,500 |
| **Deductible** | AED 1,500 | AED 500 | None |
| **Network** | Restricted — basic clinics + select general hospitals; no premium/private hospitals | Standard — clinics and hospitals; excludes top-tier private hospitals | Wide — includes premium and private hospitals |
| **Outpatient co-pay** | 30% | 20% | 10% |
| **Maternity** | Not covered | Covered — **12-month waiting period**, limit AED 10,000 | Covered — 3-month waiting period, limit AED 25,000 |
| **Chronic / pre-existing** | Not covered | Covered — **6-month waiting period** | Covered — no waiting period |
| **Annual limit** | AED 150,000 | AED 500,000 | AED 1,500,000 |
| **Dental / optical** | None | Basic (optical exam + basic dental) | Full |

### Notes for builders

- A **waiting period** means the benefit exists on paper but won't pay out until that many months of continuous cover have passed. A plan that "covers maternity" with a 12-month wait is no help to someone who needs it within the year — reading past the yes/no matters.
- "More coverage" is not automatically "better." The right plan depends on the applicant: paying for Comprehensive when Essential covers your needs is wasted money; buying Balanced for a benefit you'll need before its waiting period clears is a false economy.
- Network tier affects which hospitals an applicant can actually use, not just price.
