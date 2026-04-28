"use client"

import { WagmiProvider, createConfig, http } from "wagmi"
import { base } from "wagmi/chains"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ConnectKitProvider, getDefaultConfig } from "connectkit"

const RPC = process.env.NEXT_PUBLIC_BASE_RPC || "https://mainnet.base.org"

const config = createConfig(
  getDefaultConfig({
    chains: [base],
    transports: { [base.id]: http(RPC) },
    walletConnectProjectId: "0",
    appName: "PromptChancery",
  })
)

const queryClient = new QueryClient()

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ConnectKitProvider>
          {children}
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
