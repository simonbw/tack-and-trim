use crate::region::BoundingBox;

pub const FEET_PER_METER: f64 = 3.280_839_895_013_123;
const EARTH_RADIUS_METERS: f64 = 6_378_137.0;

pub fn meters_to_feet(meters: f64) -> f64 {
    meters * FEET_PER_METER
}

pub fn feet_to_meters(feet: f64) -> f64 {
    feet / FEET_PER_METER
}

pub fn bbox_center(bbox: &BoundingBox) -> (f64, f64) {
    (
        (bbox.min_lat + bbox.max_lat) * 0.5,
        (bbox.min_lon + bbox.max_lon) * 0.5,
    )
}

pub fn lat_lon_to_feet(lat: f64, lon: f64, center_lat: f64, center_lon: f64) -> (f64, f64) {
    let lat_rad = lat.to_radians();
    let center_lat_rad = center_lat.to_radians();
    let d_lat_rad = (lat - center_lat).to_radians();
    let d_lon_rad = (lon - center_lon).to_radians();

    let y_meters = d_lat_rad * EARTH_RADIUS_METERS;
    let x_meters = d_lon_rad * EARTH_RADIUS_METERS * ((lat_rad + center_lat_rad) * 0.5).cos();

    (meters_to_feet(x_meters), meters_to_feet(y_meters))
}

pub fn normalize_dataset_path(dataset_path: &str) -> String {
    let normalized = dataset_path.trim().trim_start_matches('/');
    if normalized.ends_with('/') {
        normalized.to_string()
    } else {
        format!("{normalized}/")
    }
}

pub fn bbox_intersects(a: &BoundingBox, b: &BoundingBox) -> bool {
    !(a.max_lat <= b.min_lat
        || a.min_lat >= b.max_lat
        || a.max_lon <= b.min_lon
        || a.min_lon >= b.max_lon)
}

pub fn parse_tile_coverage_from_name(name: &str) -> Option<BoundingBox> {
    let re = regex::Regex::new(r"_([ns])(\d{1,2})x(\d{2})_([ew])(\d{1,3})x(\d{2})_").ok()?;
    let caps = re.captures(name)?;

    let lat_sign = if &caps[1].to_ascii_lowercase() == "s" {
        -1.0
    } else {
        1.0
    };
    let lon_sign = if &caps[4].to_ascii_lowercase() == "w" {
        -1.0
    } else {
        1.0
    };

    let lat_value: f64 = caps[2].parse::<f64>().ok()? + caps[3].parse::<f64>().ok()? / 100.0;
    let lon_value: f64 = caps[5].parse::<f64>().ok()? + caps[6].parse::<f64>().ok()? / 100.0;

    let lat_value = lat_value * lat_sign;
    let lon_value = lon_value * lon_sign;

    // CUDEM ninth-arcsecond filenames encode quarter-degree-ish tile corners.
    // In this dataset, latitude token indicates the northern edge; longitude token
    // indicates the western edge.
    let tile_span_degrees = 0.2505;
    let edge_padding_degrees = 0.0005;

    Some(BoundingBox {
        min_lat: lat_value - tile_span_degrees,
        max_lat: lat_value + edge_padding_degrees,
        min_lon: lon_value - edge_padding_degrees,
        max_lon: lon_value + tile_span_degrees,
    })
}
