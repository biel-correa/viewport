fn main() {
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("src/camera/mac_avfoundation.m")
            .flag("-fobjc-arc")
            .compile("mac_avfoundation");

        cc::Build::new()
            .file("src/clipboard/mac_pasteboard.m")
            .flag("-fobjc-arc")
            .compile("mac_pasteboard");

        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=CoreMedia");
        println!("cargo:rustc-link-lib=framework=CoreVideo");
        println!("cargo:rustc-link-lib=framework=ImageIO");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
}
