use num_format::{Locale, ToFormattedString};

pub fn int<T: ToFormattedString>(value: T) -> String {
    value.to_formatted_string(&Locale::en)
}
