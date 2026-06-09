extern crate napi_build;

fn main() {
    napi_build::setup();

    // libgit2 on Windows needs these system libraries.
    // They should be linked by libgit2-sys but aren't always pulled in correctly.
    #[cfg(target_os = "windows")]
    {
        println!("cargo:rustc-link-lib=advapi32");
    }
}
