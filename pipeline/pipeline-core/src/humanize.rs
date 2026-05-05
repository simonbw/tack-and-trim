use num_format::{Locale, ToFormattedString};

pub fn format_int<T: ToFormattedString>(value: T) -> String {
    value.to_formatted_string(&Locale::en)
}
