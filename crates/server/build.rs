use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn collect(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).expect("read embedded asset directory") {
        let entry = entry.expect("read embedded asset entry");
        let kind = entry.file_type().expect("read embedded asset type");
        assert!(
            !kind.is_symlink(),
            "embedded assets must not contain symlinks"
        );
        assert!(
            !entry.file_name().to_string_lossy().starts_with('.'),
            "hidden files must not be embedded"
        );
        if kind.is_dir() {
            collect(root, &entry.path(), files);
        } else if kind.is_file() {
            files.push(entry.path().strip_prefix(root).unwrap().to_owned());
        }
    }
}

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest.join("assets");
    println!("cargo:rerun-if-changed=assets");
    let mut files = vec![];
    collect(&root, &root, &mut files);
    files.sort();
    assert!(
        files.iter().any(|file| file == Path::new("index.html")),
        "embedded index.html is required"
    );
    let mut generated = String::from("static EMBEDDED_ASSETS: &[Asset] = &[\n");
    for file in files {
        let public = format!(
            "/{}",
            file.components()
                .map(|part| part.as_os_str().to_str().unwrap())
                .collect::<Vec<_>>()
                .join("/")
        );
        let path = root.join(&file);
        let bytes = fs::read(&path).expect("read embedded asset");
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let stem = file.file_stem().unwrap().to_str().unwrap();
        let fingerprint = stem
            .rsplit_once(['.', '-'])
            .map(|(_, fingerprint)| fingerprint);
        let immutable = fingerprint.is_some_and(|fingerprint| {
            fingerprint.len() >= 8
                && fingerprint.len() <= 64
                && fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
                && digest.starts_with(fingerprint)
        });
        let content_type = match file.extension().and_then(|extension| extension.to_str()) {
            Some("html") => "text/html; charset=utf-8",
            Some("js") => "application/javascript; charset=utf-8",
            Some("css") => "text/css; charset=utf-8",
            Some("json") => "application/json",
            Some("svg") => "image/svg+xml",
            Some("png") => "image/png",
            Some("jpg" | "jpeg") => "image/jpeg",
            Some("ico") => "image/x-icon",
            Some("woff2") => "font/woff2",
            Some("woff") => "font/woff",
            _ => "application/octet-stream",
        };
        generated.push_str(&format!("Asset {{ path: {public:?}, bytes: include_bytes!({:?}), content_type: {content_type:?}, immutable: {immutable} }},\n", path.to_str().unwrap()));
    }
    generated.push_str("];\n");
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("embedded_assets.rs"),
        generated,
    )
    .unwrap();
}
