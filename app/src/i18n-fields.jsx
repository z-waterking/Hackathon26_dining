// Labels are localized by callers; editable record values always stay original.
export const LocalizedTextarea = props => <textarea {...props} />;
export const LocalizedInput = props => <input {...props} />;
// Keep the existing form API without a translated shadow value.
// oxlint-disable-next-line react/only-export-components
export function localizedFormData(form) {
  return new FormData(form);
}
