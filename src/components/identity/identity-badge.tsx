import { useEffect } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Avatar } from "@/components/ui/avatar"
import { IdentityMenu } from "@/components/identity/identity-menu"
import { github, useGitHub } from "@/state/github"
import { UserIcon } from "lucide-react"

/**
 * Who you are, in the titlebar — a slot contribution like anything a plugin
 * would add, nothing privileged. Ghost when GitHub is not connected rather
 * than hidden: identity being visible is the point, and the empty state is
 * the doorway to setting it up.
 */
export function IdentityBadge() {
  const login = useGitHub((state) => state.status?.login)
  const avatar = useGitHub((state) => state.userAvatar)

  useEffect(() => {
    void github.ensureStatus()
  }, [])

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={login ? `Signed in as ${login}` : "Connect an identity"}
          className="pressable no-drag flex size-7 items-center justify-center rounded-md transition-colors duration-100 hover:bg-fill-hover aria-expanded:bg-fill-selected"
        >
          {login ? (
            <Avatar src={avatar} name={login} size={5} className="rounded-full" />
          ) : (
            <UserIcon className="size-3.5 text-faint" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-auto p-2">
        <IdentityMenu />
      </PopoverContent>
    </Popover>
  )
}
