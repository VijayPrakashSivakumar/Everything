# Everything - Automation Analysis

This project is a capture/note-taking application with significant automation features designed to help users work more efficiently.

## Key Automation Areas

### 1. Smart Capture / Auto-create (Primary - Enhanced)
- **What it does**: A single clear sentence can create multiple items automatically
- **Example**: "Meeting with the design team at 9 tomorrow..." creates a meeting, discussion, and proposal
- **Benefit**: Eliminates manual item creation and categorization
- **Control**: Users can toggle `captureSmartEnabled` on/off
- **Philosophy**: Visible automation - users can see and take back automated decisions
- **Enhancement**: Added visible feedback when auto-save is about to happen, plus extra guard to respect manual plan adjustments

### 2. Type Detection
- Automatic classification of capture type from text content
- Distinguishes: text, event, task, expense, bill, link, file, voice, image
- Respects user choices via `captureAutoDetected` flag

### 3. Inline Help
- "i" icons beside non-obvious fields
- Provides contextual explanations
- Accessibility-enhanced with proper label associations

### 4. Smart Suggestions
- Auto-fills type, date, person, project, and priority
- Users can edit before saving
- Optional via `captureSmartEnabled` toggle

## User Impact

The **Smart Capture / Auto-create** feature provides the most help to users by:
- Reducing repetitive data entry
- Organizing captures into appropriate item types automatically
- Maintaining user control and visibility
- Supporting both text and voice input modes
- **New**: Users now see visible feedback ("Saving…") before auto-save completes
- **New**: Manual plan adjustments are respected - auto-create won't fire if user has corrected the plan

### Voice Language Selection

- **New**: Users can now explicitly choose the dictation language via visible language chips
- **Supported languages**: English (en-IN), Tamil (ta-IN), Hindi (hi-IN), Telugu (te-IN), Kannada (kn-IN), Malayalam (ml-IN)
- **Memory**: Language choice is remembered per user so future captures start from the preferred language
- **Fallback**: If no preference is set, the app uses the browser locale (improved from silently inheriting it, which previously caused Tamil or Hindi speakers to get English transcription)
- **How it works**: When the capture sheet opens, language chips appear at the top. Tapping a language chip sets the dictation language for that capture and remembers the choice for future uses. This follows the same "visible automation" principle as the smart capture feature - the app's decision is visible and the user can take control in one tap.

### Voice Translation Target Help Tip

- **New**: The translation language selector now has a help tip ("i" icon) explaining its purpose
- **What it does**: Off keeps your own words visible. Choose a language to translate speech into that language. The translation runs through the model and stays visible alongside the original.
- **How it works**: An "i" icon appears beside the "Translate to" label. Tapping it opens a bubble with the help text. This follows the same pattern as the recurrence and priority help tips already in the capture sheet.