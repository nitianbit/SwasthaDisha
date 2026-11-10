# Health Assessment Module

## Goal

This module performs a user health risk assessment and then:

1. scores the submitted answers into risk categories
2. fetches live external vendor diagnostics packages
3. fetches live external vendor doctors
4. checks whether those recommendations are available in the next 24 hours
5. records missing package/doctor demand into a persistent backlog

It does not modify existing booking, package, specialist, or external booking flows.

## Module Location

All new code lives under:

- `src1/modules/healthAssessments`

Main files:

- `types/index.ts`
- `model/index.ts`
- `model/missingOffering.ts`
- `repository/index.ts`
- `repository/missingOffering.ts`
- `services/index.ts`
- `controller/index.ts`
- `validation/index.ts`
- `routes/index.ts`

Route registration:

- `src1/routes/index.ts`

## Step By Step Flow

### 1. Questionnaire metadata

`GET /api/v1/health-assessments/questionnaire`

Frontend can call this endpoint to render the current question sections and fields dynamically.

### 2. User submits assessment

`POST /api/v1/health-assessments`

The request accepts:

- profile
- lifestyle
- medical history
- family history
- symptoms
- vitals
- concerns
- goals
- notes

The service also merges missing profile data from the logged-in user record where possible.

### 3. Risk scoring

Inside `HealthAssessmentService`, the submitted data is converted into risk scores for:

- diabetes
- cardiac
- thyroid
- women health
- respiratory
- liver
- kidney
- general wellness

Each risk gets:

- `score`
- `level`
- `reasons`

Overall risk is derived from the highest category severity.

### 4. External package recommendations

The service fetches live vendor packages from LabStack using the existing integration:

- `LabstackService.getPackages()`

Then it:

1. scores package text against risk keywords
2. fetches package details for top candidates
3. re-scores using richer package metadata
4. if `pincode` is available, checks diagnostics slots for today and tomorrow
5. keeps only packages with best relevance and marks whether they are available in the next 24 hours

Returned package fields include:

- `packageId`
- `name`
- `category`
- `availableInNext24Hours`
- `nextAvailableSlot`
- `reason`

### 5. External doctor recommendations

For each top non-low risk category, the service maps it to desired doctor specializations.

Examples:

- diabetes -> `Endocrinologist`, `Diabetologist`
- cardiac -> `Cardiologist`
- thyroid -> `Endocrinologist`
- women health -> `Gynecologist`

Then it:

1. fetches live doctors from LabStack through the existing external booking service
2. checks doctor slots for today and tomorrow
3. marks whether each doctor is available in the next 24 hours
4. returns the top ranked doctors per risk area

Returned doctor fields include:

- `specialistId`
- `name`
- `specialization`
- `availableInNext24Hours`
- `nextAvailableSlot`

### 6. Missing offering backlog

If the assessment determines that a package or doctor specialization should ideally be recommended but no matching external vendor option is found, the service records that gap.

This is stored in the `MissingOffering` collection.

Tracked fields:

- `kind`: `doctor` or `package`
- `riskCategory`
- `desiredLabel`
- `reasons`
- `occurrenceCount`
- `firstSuggestedAt`
- `lastSuggestedAt`
- `lastTriggeredByUserId`

Every time the same gap is encountered again, `occurrenceCount` is incremented.

This creates a growing acquisition backlog of services you should consider onboarding.

### 7. Saved assessment result

The final saved assessment contains:

- original answers
- computed metrics like BMI
- scored risks
- recommendations
- missing offerings detected during recommendation generation

## Endpoints

### User endpoints

- `GET /api/v1/health-assessments/questionnaire`
- `POST /api/v1/health-assessments`
- `GET /api/v1/health-assessments/me`
- `GET /api/v1/health-assessments/:id`

### Admin endpoint

- `GET /api/v1/health-assessments/admin/missing-offerings`

This endpoint returns the accumulated backlog of missing external doctors/packages.

## Notes

- Live recommendations depend on LabStack availability at the time of request.
- `pincode` strongly improves accuracy for diagnostics availability and doctor discovery.
- The module is additive and does not alter existing booking flows.
- The recommendation engine is still rule-based. It is not a diagnosis engine.
