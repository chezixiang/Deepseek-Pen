// 宿主侧 mint 调试：调用 mint_device_id 并把请求体落盘（DS_MINT_DUMP）
// 运行：DS_MINT_DUMP=/tmp/mint cargo run --example mint_probe
#[tokio::main]
async fn main() {
    let ua = ds_free_api::ds_core::default_user_agent();
    match ds_free_api::ds_core::mint_device_id(&ua).await {
        Ok(id) => println!("MINT_OK len={} id={}", id.len(), &id[..id.len().min(40)]),
        Err(e) => println!("MINT_ERR {e}"),
    }
}
